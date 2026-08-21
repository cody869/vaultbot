#!/usr/bin/env node
/*
 * Switch the EA league (Madden save file) the bot is connected to,
 * WITHOUT redoing the full OAuth relink in linkEA.js.
 *
 * Use this when you started a new save/franchise on the SAME EA account
 * and persona — the stored token is still valid, only leagueId/leagueName
 * need to change.
 *
 * If EA rejects the stored token outright (EAAccountError telling you to
 * relink), the account/persona itself changed — use linkEA.js instead.
 *
 * Run this wherever EA_STORE_PATH is reachable — i.e. on the Railway
 * volume (via `railway run node switchLeague.js` or a Railway shell),
 * NOT on your laptop, since it reads/writes /data/ea.json directly.
 */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { getConnection, saveConnection, STORE_PATH } from "./eaTokenStore.js";
import { refreshToken, retrieveBlazeSession, createEAClient } from "./eaClient.js";

async function main() {
  console.log(`\nReading current connection from ${STORE_PATH}...\n`);
  const stored = await getConnection();
  console.log(`Currently linked: "${stored.leagueName ?? "unknown"}" (id ${stored.leagueId})\n`);

  const token = await refreshToken(stored.token);
  const session = await retrieveBlazeSession(token);
  const client = await createEAClient(token, session);

  console.log("Fetching leagues on this persona...\n");
  const leagues = await client.getLeagues();
  if (!leagues.length) throw new Error("No Madden leagues found on this persona.");

  const rl = readline.createInterface({ input, output });

  leagues.forEach((l, i) => {
    console.log(`  [${i + 1}] ${l.leagueName} — ${l.userTeamName} (id ${l.leagueId})`);
  });

  let league;
  while (!league) {
    const answer = await rl.question("\nWhich league is the new save file? ");
    const idx = Number(answer.trim()) - 1;
    if (Number.isInteger(idx) && leagues[idx]) league = leagues[idx];
    else console.log("  Not a valid choice, try again.");
  }

  await saveConnection({
    token: { ...token, session: undefined },
    leagueId: league.leagueId,
    leagueName: league.leagueName,
  });

  console.log(`\nSwitched to "${league.leagueName}" (id ${league.leagueId}).`);
  console.log(`Written to ${STORE_PATH}.\n`);
  console.log("Restart the bot process so it picks up the new leagueId on next connect.\n");

  rl.close();
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  if (e.troubleshoot) console.error(`Hint: ${e.troubleshoot}`);
  process.exit(1);
});
