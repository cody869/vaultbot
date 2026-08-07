// news.js — pushes published Vault articles into #content and serves /news.
//
// Mirrors the tradeVoting.js watcher pattern: poll on an interval, claim each
// record in an in-memory Set before posting so a race can't double-post, and
// write the Discord message id back onto the record so a restart can't repeat
// itself.
//
// Environment:
//   CONTENT_CHANNEL_ID   required — the #content channel (654425873004625929)
//   NEWS_PING_ROLE_ID    optional — pinged only on staff posts / Announcements
//   NEWS_POLL_SECONDS    optional — default 60
//   NEWS_SEED_HOURS      optional — default 24 (first-boot backlog grace window)
//   VAULT_PUBLIC_URL     already used by embeds.js for links

import crypto from "node:crypto";
import { SlashCommandBuilder } from "discord.js";
import { list, updateEntity } from "./vault.js";
import { playerUrl, teamUrl, routeUrl } from "./embeds.js";
import { teamEmojiByName } from "./emoji.js";

const ENTITY = "NewsArticle";
const CONTENT_CHANNEL_ID = process.env.CONTENT_CHANNEL_ID || "654425873004625929";
const POLL_MS = Number(process.env.NEWS_POLL_SECONDS || 60) * 1000;
const SEED_HOURS = Number(process.env.NEWS_SEED_HOURS || 24);
const PING_ROLE_ID = process.env.NEWS_PING_ROLE_ID || "";

const articleUrl = (a) => routeUrl(`/news/${encodeURIComponent(a.slug || a.id)}`);

// Articles we've already handled this process, so a slow post can't be picked
// up twice by the next tick.
const handled = new Set();

// --- helpers --------------------------------------------------------------

function trim(s, n) {
  const t = String(s ?? "").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

// Strip markdown + our [[player:…]] shortcodes down to readable plain text.
function plain(md) {
  return String(md ?? "")
    .replace(/\[\[(?:player|team|member):([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

// Content fingerprint — when this changes on an already-posted article, the
// watcher edits the Discord message instead of reposting.
function syncHash(a) {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        a.title,
        a.dek,
        a.excerpt,
        a.category,
        a.cover_image_url,
        a.linked_players,
        a.linked_teams,
        (a.attachments ?? []).map((f) => f.url),
      ])
    )
    .digest("hex")
    .slice(0, 16);
}

// Plain markdown, not an embed — embeds don't render inline links, and the
// player/team links are the point. Same call we made for /player and /tradeblock.
export function newsMessage(a) {
  const out = [];

  out.push(`# ${trim(a.title, 220)}`);

  const meta = [
    a.category,
    a.author_display_name ? `by ${a.author_display_name}` : null,
    a.read_minutes ? `${a.read_minutes} min read` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (meta) out.push(`-# ${meta}`);

  if (a.dek) out.push(`### ${trim(a.dek, 200)}`);

  const blurb = plain(a.excerpt || a.body);
  if (blurb) {
    out.push("");
    out.push(trim(blurb.split(/\n{2,}/)[0], 700));
  }

  out.push("");
  out.push(`**[Read the full story](${articleUrl(a)})**`);

  const teams = (a.linked_teams ?? []).slice(0, 6);
  if (teams.length) {
    out.push(
      `> ${teams.map((t) => `${teamEmojiByName(t)} [${t}](${teamUrl(t)})`).join(" · ")}`
    );
  }

  const players = (a.linked_players ?? []).slice(0, 8);
  if (players.length) {
    out.push(`> ${players.map((p) => `[${p}](${playerUrl(p)})`).join(" · ")}`);
  }

  const files = (a.attachments ?? []).filter((f) => f?.url).slice(0, 5);
  if (files.length) {
    out.push(`> Attachments: ${files.map((f) => `[${f.name || "File"}](${f.url})`).join(" · ")}`);
  }

  const links = (a.external_links ?? []).filter((l) => l?.url).slice(0, 5);
  if (links.length) {
    out.push(`> ${links.map((l) => `[${l.label || "Link"}](${l.url})`).join(" · ")}`);
  }

  // Bare URL last so Discord unfurls the cover photo as the message preview.
  if (a.cover_image_url) out.push(a.cover_image_url);

  let content = out.join("\n");
  if (PING_ROLE_ID && (a.is_staff_post || a.category === "Announcement")) {
    content = `<@&${PING_ROLE_ID}>\n${content}`;
  }
  return content.length > 1950 ? `${content.slice(0, 1947)}…` : content;
}

// --- posting --------------------------------------------------------------

async function postArticle(client, a) {
  const channel = await client.channels.fetch(CONTENT_CHANNEL_ID);
  if (!channel?.isTextBased?.()) {
    throw new Error(`CONTENT_CHANNEL_ID ${CONTENT_CHANNEL_ID} is not a text channel`);
  }

  const msg = await channel.send({
    content: newsMessage(a),
    allowedMentions: { parse: PING_ROLE_ID ? ["roles"] : [] },
  });

  let threadId = "";
  let threadUrl = "";
  if (a.allow_discussion !== false && typeof msg.startThread === "function") {
    try {
      const thread = await msg.startThread({
        name: trim(a.title, 90),
        autoArchiveDuration: 10080, // 7 days
        reason: "XCFL Vault article discussion",
      });
      threadId = thread.id;
      threadUrl = thread.url ?? "";
    } catch (err) {
      // Missing "Create Public Threads" — the article still posted.
      console.warn(`[NEWS] thread creation failed: ${err.message}`);
    }
  }

  await updateEntity(ENTITY, a.id, {
    discord_message_id: msg.id,
    discord_message_url: threadUrl || msg.url || "",
    discord_thread_id: threadId,
    discord_posted_at: new Date().toISOString(),
    discord_sync_hash: syncHash(a),
  });

  console.log(
    `[NEWS] posted "${a.title}" (${a.id}) → ${msg.id}${threadId ? ` thread ${threadId}` : ""}`
  );
}

async function editArticle(client, a) {
  const channel = await client.channels.fetch(CONTENT_CHANNEL_ID);
  const msg = await channel.messages.fetch(a.discord_message_id);
  await msg.edit({ content: newsMessage(a), allowedMentions: { parse: [] } });
  await updateEntity(ENTITY, a.id, { discord_sync_hash: syncHash(a) });
  console.log(`[NEWS] updated "${a.title}" (${a.id})`);
}

// --- watcher --------------------------------------------------------------

// Server-side filters aren't reliable here (same as everywhere else in the
// bot), so pull broad and decide in memory.
async function fetchArticles(limit = 500) {
  return list(ENTITY, {}, { sort: "-published_at", limit });
}

function isDue(a) {
  if (a.status !== "published") return false;
  if (a.scheduled_for && new Date(a.scheduled_for).getTime() > Date.now()) return false;
  return true;
}

function publishedTime(a) {
  return new Date(a.published_at || a.submitted_at || a.created_date || 0).getTime();
}

async function tick(client, { seed = false } = {}) {
  let rows;
  try {
    rows = await fetchArticles();
  } catch (err) {
    console.error(`[NEWS] fetch failed: ${err.message}`);
    return;
  }

  const cutoff = Date.now() - SEED_HOURS * 3600 * 1000;

  for (const a of rows) {
    if (!a?.id || handled.has(a.id)) continue;

    // --- brand new story ---
    if (isDue(a) && !a.discord_message_id) {
      handled.add(a.id); // claim up front so a race can't double-post

      // First boot on an app that already has articles: mark the backlog as
      // handled rather than dumping it all into #content.
      if (seed && publishedTime(a) < cutoff) {
        try {
          await updateEntity(ENTITY, a.id, {
            discord_message_id: "skipped-backfill",
            discord_posted_at: new Date().toISOString(),
          });
          console.log(`[NEWS] seeded (not posted): ${a.title}`);
        } catch (err) {
          console.warn(`[NEWS] seed stamp failed for ${a.id}: ${err.message}`);
          handled.delete(a.id);
        }
        continue;
      }

      try {
        await postArticle(client, a);
      } catch (err) {
        console.error(`[NEWS] post failed for ${a.id}: ${err.message}`);
        handled.delete(a.id); // let a later tick retry
      }
      continue;
    }

    // --- already posted, but the article changed ---
    if (
      a.status === "published" &&
      a.discord_message_id &&
      a.discord_message_id !== "skipped-backfill" &&
      a.discord_sync_hash &&
      a.discord_sync_hash !== syncHash(a)
    ) {
      handled.add(a.id);
      try {
        await editArticle(client, a);
      } catch (err) {
        console.warn(`[NEWS] edit failed for ${a.id}: ${err.message}`);
      } finally {
        handled.delete(a.id); // edits can happen more than once
      }
    }
  }
}

export function startNewsWatcher(client) {
  if (!CONTENT_CHANNEL_ID) {
    console.log("[NEWS] watcher disabled — no CONTENT_CHANNEL_ID set.");
    return;
  }
  console.log(
    `[NEWS] watcher starting — channel ${CONTENT_CHANNEL_ID}, every ${POLL_MS / 1000}s`
  );

  // First pass seeds the backlog instead of posting it.
  tick(client, { seed: true })
    .catch((err) => console.error(`[NEWS] seed pass failed: ${err.message}`))
    .finally(() => {
      setInterval(() => {
        tick(client).catch((err) => console.error(`[NEWS] poll failed: ${err.message}`));
      }, POLL_MS);
    });
}

// --- /news ----------------------------------------------------------------

export const CATEGORY_CHOICES = [
  "League News",
  "Team Report",
  "Analysis",
  "Recap",
  "Draft",
  "Trade Talk",
  "Interview",
  "Op-Ed",
  "Rumor Mill",
  "Announcement",
  "History",
];

export const newsCommand = new SlashCommandBuilder()
  .setName("news")
  .setDescription("Latest articles from the Vault newsroom")
  .addStringOption((o) =>
    o
      .setName("category")
      .setDescription("Filter by category")
      .addChoices(...CATEGORY_CHOICES.map((c) => ({ name: c, value: c })))
  )
  .addIntegerOption((o) =>
    o.setName("count").setDescription("How many to show (1-10)").setMinValue(1).setMaxValue(10)
  );

// index.js already deferred before the switch — do NOT defer again here
// (that's what broke /bug-status).
export async function handleNews(interaction) {
  const category = interaction.options.getString("category") ?? null;
  const count = interaction.options.getInteger("count") ?? 5;

  const rows = await fetchArticles();

  const list_ = rows
    .filter((a) => a.status === "published")
    .filter((a) => !category || a.category === category)
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return publishedTime(b) - publishedTime(a);
    })
    .slice(0, count);

  if (!list_.length) {
    await interaction.editReply(
      category
        ? `Nothing filed under **${category}** yet. Write the first one: <${routeUrl("/submit-article")}>`
        : `The newsroom is empty. Be the first byline: <${routeUrl("/submit-article")}>`
    );
    return;
  }

  const out = [`# ${category ?? "Latest from the newsroom"}`];
  for (const a of list_) {
    const when = publishedTime(a)
      ? `<t:${Math.floor(publishedTime(a) / 1000)}:R>`
      : "";
    out.push(`### [${trim(a.title, 120)}](${articleUrl(a)})`);
    out.push(
      `-# ${[a.pinned ? "PINNED" : null, a.category, a.author_display_name, when]
        .filter(Boolean)
        .join(" · ")}`
    );
    const blurb = plain(a.dek || a.excerpt);
    if (blurb) out.push(`> ${trim(blurb, 180)}`);
  }
  out.push(`-# Submit your own: <${routeUrl("/submit-article")}>`);

  await interaction.editReply(out.join("\n").slice(0, 1950));
}
