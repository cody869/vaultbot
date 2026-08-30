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
//   NEWS_PING_EVERYONE   optional — "all" pings @everyone on every post,
//                        "staff" only on staff/Announcement posts (default),
//                        "off" never. Defaults to "all".
//   NEWS_POLL_SECONDS    optional — default 60
//   NEWS_SEED_HOURS      optional — default 24 (first-boot backlog grace window)
//   VAULT_PUBLIC_URL     already used by embeds.js for links

import crypto from "node:crypto";
import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { list, updateEntity, pollCached } from "./vault.js";
import { isRateLimited } from "./base44Pacer.js";
import { withFileLock } from "./fileLock.js";
import { playerUrl, teamUrl, routeUrl } from "./embeds.js";
import { teamEmojiByName } from "./emoji.js";

const ENTITY = "NewsArticle";
const CONTENT_CHANNEL_ID = process.env.CONTENT_CHANNEL_ID || "654425873004625929";
// Article posts are inherently asynchronous editorial content -- a several-
// minute delay reads as normal for a news feed, unlike live game scores.
const POLL_MS = Number(process.env.NEWS_POLL_SECONDS || 360) * 1000;
const SEED_HOURS = Number(process.env.NEWS_SEED_HOURS || 24);
const PING_ROLE_ID = process.env.NEWS_PING_ROLE_ID || "";

// @everyone policy: "all" (default) | "staff" | "off".
const PING_EVERYONE = (process.env.NEWS_PING_EVERYONE || "all").toLowerCase();

// Decide whether a given article should ping @everyone.
function shouldPingEveryone(a) {
  if (PING_EVERYONE === "off") return false;
  if (PING_EVERYONE === "staff") return !!a.is_staff_post || a.category === "Announcement";
  return true; // "all"
}

// Discord suppresses @everyone / role pings unless the send explicitly allows
// them. Build the allow-list to match exactly what the message contains.
function allowedMentionsFor(a) {
  const parse = [];
  if (shouldPingEveryone(a)) parse.push("everyone");
  if (PING_ROLE_ID && (a.is_staff_post || a.category === "Announcement")) parse.push("roles");
  return { parse };
}

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

  // No bare cover URL and no auto-unfurls — the post is plain text with inline
  // links only. See SUPPRESS_EMBEDS in postArticle().

  let content = out.join("\n");

  // Build the mention prefix. @everyone leads; a configured role ping stacks
  // after it (role ping still limited to staff/Announcement, as before).
  const mentions = [];
  if (shouldPingEveryone(a)) mentions.push("@everyone");
  if (PING_ROLE_ID && (a.is_staff_post || a.category === "Announcement")) {
    mentions.push(`<@&${PING_ROLE_ID}>`);
  }
  if (mentions.length) content = `${mentions.join(" ")}\n${content}`;

  return content.length > 1950 ? `${content.slice(0, 1947)}…` : content;
}

// --- posting --------------------------------------------------------------

// The record itself is the lock. Before sending anything to Discord we stamp
// discord_message_id with a claim token and re-read to confirm WE own it. If a
// second container (deploy overlap) or a restart raced us, the re-read shows a
// different token and we back off — so the article posts exactly once even
// though the in-memory `handled` Set was empty after a restart.
//
// That write-then-reread alone is only an optimistic check, not real mutual
// exclusion -- confirmed live on suspensionWatcher.js's identical pattern,
// several overlapping containers (a Railway redeploy doesn't guarantee the
// old container is gone before the new one starts) can each see their OWN
// write on their OWN reread before any other's write lands, so all of them
// think they won. withFileLock makes only one container able to run this
// function at a time (same primitive eaTokenStore.js already relies on for
// this exact class of problem), so the reread here now actually verifies
// what it always claimed to.
async function claim(a) {
  return withFileLock('news-claim', async () => {
    const token = `posting:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await updateEntity(ENTITY, a.id, { discord_message_id: token });

    // Confirm the claim stuck and nobody overwrote it between write and read.
    const [fresh] = (await list(ENTITY, { id: a.id }, { limit: 1 })) || [];
    const current = fresh?.discord_message_id;
    if (current !== token) {
      console.log(`[NEWS] claim lost for ${a.id} (now ${current}) — another instance has it`);
      return null;
    }
    return token;
  });
}

async function postArticle(client, a) {
  const channel = await client.channels.fetch(CONTENT_CHANNEL_ID);
  if (!channel?.isTextBased?.()) {
    throw new Error(`CONTENT_CHANNEL_ID ${CONTENT_CHANNEL_ID} is not a text channel`);
  }

  // Take the lock BEFORE sending. If we don't win it, do nothing.
  const token = await claim(a);
  if (!token) return;

  let msg;
  try {
    msg = await channel.send({
      content: newsMessage(a),
      allowedMentions: allowedMentionsFor(a),
      // SuppressEmbeds: no link previews and no image unfurl — plain text + inline links only.
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    // Send failed after we claimed — release the claim so a later tick retries.
    await updateEntity(ENTITY, a.id, { discord_message_id: "" }).catch(() => {});
    throw err;
  }

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

  // Replace the claim token with the real message id. Retry a couple of times:
  // if this write is lost the article would look unposted and repost next tick,
  // which is the exact bug we're fixing.
  const finalUpdate = {
    discord_message_id: msg.id,
    discord_message_url: threadUrl || msg.url || "",
    discord_thread_id: threadId,
    discord_posted_at: new Date().toISOString(),
    discord_sync_hash: syncHash(a),
  };
  let saved = false;
  for (let attempt = 1; attempt <= 3 && !saved; attempt++) {
    try {
      await updateEntity(ENTITY, a.id, finalUpdate);
      saved = true;
    } catch (err) {
      console.warn(`[NEWS] stamp attempt ${attempt} failed for ${a.id}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  if (!saved) {
    // The message is live but we couldn't record its id. Leave the claim token
    // in place (NOT empty) so the watcher treats it as handled and never
    // reposts. It just won't get edit-sync or a thread jump link.
    console.error(`[NEWS] could not persist message id for ${a.id}; left claim token to prevent a repost`);
  }

  console.log(
    `[NEWS] posted "${a.title}" (${a.id}) → ${msg.id}${threadId ? ` thread ${threadId}` : ""}`
  );
}

async function editArticle(client, a) {
  const channel = await client.channels.fetch(CONTENT_CHANNEL_ID);
  const msg = await channel.messages.fetch(a.discord_message_id);
  await msg.edit({
    content: newsMessage(a),
    allowedMentions: { parse: [] },
    flags: MessageFlags.SuppressEmbeds,
  });
  await updateEntity(ENTITY, a.id, { discord_sync_hash: syncHash(a) });
  console.log(`[NEWS] updated "${a.title}" (${a.id})`);
}

// --- watcher --------------------------------------------------------------

// Server-side filters aren't reliable here (same as everywhere else in the
// bot), so pull broad and decide in memory.
async function fetchArticles(limit = 500) {
  // Backs both the watcher tick and /news — neither needs sub-minute
  // freshness, and re-reading the whole collection every tick with no
  // caching was part of what tripped Base44's read-rate limit.
  return pollCached(`news:${limit}`, 355_000, () => list(ENTITY, {}, { sort: "-published_at", limit }));
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
  // An app-wide Base44 pause is in effect (see base44Pacer.js) -- sit this
  // tick out rather than piling onto it. The next tick checks again.
  if (isRateLimited()) return;

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

    // A non-empty discord_message_id means posted, skipped, or currently being
    // claimed by another instance (`posting:…`). Any of those = leave it alone.
    const alreadyTaken = !!a.discord_message_id;

    // --- brand new story ---
    if (isDue(a) && !alreadyTaken) {
      handled.add(a.id); // fast in-process guard; the record claim is the real lock

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
    // Only real Discord message ids qualify — not "skipped-backfill" and not a
    // "posting:…" claim token still mid-flight.
    if (
      a.status === "published" &&
      a.discord_message_id &&
      a.discord_message_id !== "skipped-backfill" &&
      !a.discord_message_id.startsWith("posting:") &&
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
