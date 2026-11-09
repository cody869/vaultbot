// hofPlaques.js — /admin hof-plaques
//
// Pulls every image ever posted in a channel (the old Hall of Fame plaques)
// and hands them back to the commissioner as zip files, plus a manifest.csv
// with who posted each one, when, the caption and a jump link.
//
// Nothing is written to the Vault and nothing is posted publicly: every reply
// is an ephemeral follow-up to the person who ran the command.
//
// Discord caps a single upload by the server's boost tier (10 MB unboosted,
// 50 MB at tier 2, 100 MB at tier 3), so the images are split across as many
// zips as that takes. Images are stored, not compressed (PNG/JPG already are).
//
// Needs: View Channel + Read Message History in the target channel.

import { AttachmentBuilder } from "discord.js";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)(\?|$)/i;

// ── tiny store-only zip writer ────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = f.data;
    const crc = crc32(data);
    const { time, date } = dosTime(f.date || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ── helpers ───────────────────────────────────────────────────────────────
function uploadLimitBytes(guild) {
  const tier = guild?.premiumTier ?? 0;
  const mb = tier >= 3 ? 100 : tier >= 2 ? 50 : 10;
  return Math.floor(mb * 1024 * 1024 * 0.92);
}

function csvCell(v) {
  const s = String(v ?? "").replace(/\r?\n/g, " ").trim();
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function safeName(s) {
  return String(s || "image").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 60);
}

async function fetchAllMessages(channel, onProgress) {
  const out = [];
  let before;
  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    out.push(...batch.values());
    before = batch.last().id;
    onProgress?.(out.length);
    if (batch.size < 100) break;
  }
  return out.reverse(); // oldest first
}

function imagesIn(msg) {
  const found = [];
  for (const a of msg.attachments.values()) {
    const isImage = (a.contentType || "").startsWith("image/") || IMAGE_EXT.test(a.name || a.url);
    if (isImage) found.push({ url: a.url, name: a.name || "image.png" });
  }
  for (const e of msg.embeds) {
    const url = e.image?.url || (e.type === "image" ? e.url : null) || e.thumbnail?.url;
    if (url && IMAGE_EXT.test(url) && !found.some((f) => f.url === url)) {
      found.push({ url, name: url.split("?")[0].split("/").pop() || "embed.png" });
    }
  }
  return found;
}

async function download(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error("download failed");
}

// ── command ───────────────────────────────────────────────────────────────
export async function handleHofPlaques(interaction) {
  const channel = interaction.options.getChannel("channel", true);
  if (!channel?.messages?.fetch) {
    await interaction.editReply("Pick a text channel the bot can read.");
    return;
  }

  await interaction.editReply(`Reading <#${channel.id}>…`);
  let messages;
  try {
    messages = await fetchAllMessages(channel, (n) => {
      if (n % 500 === 0) interaction.editReply(`Reading <#${channel.id}>… ${n} messages so far`).catch(() => {});
    });
  } catch (err) {
    await interaction.editReply(
      `Couldn't read <#${channel.id}> (${err.message}). The bot needs View Channel and Read Message History there.`
    );
    return;
  }

  const items = [];
  for (const msg of messages) {
    const imgs = imagesIn(msg);
    imgs.forEach((img, i) => items.push({ msg, img, i, count: imgs.length }));
  }
  if (!items.length) {
    await interaction.editReply(`No images found in <#${channel.id}> (${messages.length} messages checked).`);
    return;
  }

  await interaction.editReply(`Found ${items.length} images in ${messages.length} messages. Downloading…`);

  const limit = uploadLimitBytes(interaction.guild);
  const manifest = [["file", "zip", "posted_at", "posted_by", "caption", "message_link"]];
  const failed = [];
  const zips = [];
  let current = [];
  let currentBytes = 0;
  let zipNo = 1;

  const flush = () => {
    if (!current.length) return;
    zips.push({ no: zipNo++, files: current });
    current = [];
    currentBytes = 0;
  };

  for (let k = 0; k < items.length; k++) {
    const { msg, img, i, count } = items[k];
    const posted = msg.createdAt;
    const datePart = posted.toISOString().slice(0, 10);
    const ext = (img.name.match(/\.[a-z0-9]+$/i) || [".png"])[0].toLowerCase();
    const base = safeName(img.name.replace(/\.[a-z0-9]+$/i, ""));
    const fileName = `${String(k + 1).padStart(4, "0")}_${datePart}_${base}${count > 1 ? `_${i + 1}` : ""}${ext}`;

    let data;
    try {
      data = await download(img.url);
    } catch (err) {
      failed.push(`${fileName} (${err.message})`);
      continue;
    }
    if (data.length > limit) {
      failed.push(`${fileName} (bigger than the upload limit on its own)`);
      continue;
    }
    if (currentBytes + data.length > limit) flush();
    current.push({ name: fileName, data, date: posted });
    currentBytes += data.length + fileName.length + 80;

    manifest.push([
      fileName,
      `hof-plaques-${String(zipNo).padStart(2, "0")}.zip`,
      posted.toISOString(),
      msg.member?.displayName || msg.author?.username || "",
      msg.content || "",
      msg.url,
    ]);

    if ((k + 1) % 25 === 0) {
      interaction.editReply(`Downloading… ${k + 1}/${items.length}`).catch(() => {});
    }
  }
  flush();

  const csv = Buffer.from(manifest.map((row) => row.map(csvCell).join(",")).join("\n"), "utf8");

  await interaction.editReply(
    `Done: ${items.length - failed.length} of ${items.length} images in ${zips.length} zip${zips.length === 1 ? "" : "s"}` +
      `${failed.length ? ` (${failed.length} failed, listed at the end)` : ""}. Sending now — only you can see these.`
  );

  for (const z of zips) {
    const zipName = `hof-plaques-${String(z.no).padStart(2, "0")}.zip`;
    const files = z.no === 1 ? [...z.files, { name: "manifest.csv", data: csv }] : z.files;
    await interaction.followUp({
      content: `${zipName} — ${z.files.length} images`,
      files: [new AttachmentBuilder(buildZip(files), { name: zipName })],
      ephemeral: true,
    });
  }

  if (failed.length) {
    const list = failed.join("\n").slice(0, 1800);
    await interaction.followUp({ content: `Couldn't include:\n\`\`\`\n${list}\n\`\`\``, ephemeral: true });
  }
}
