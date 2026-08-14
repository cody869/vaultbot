#!/usr/bin/env node
/*
 * One-time EA link. This is the CLI replacement for snallabot's web dashboard.
 *
 * The dashboard exists because EA's OAuth ends at a localhost redirect that a
 * server can't intercept — a human has to copy the URL out of the browser.
 * Everything else it does (list personas, list leagues, pick one) is just two
 * API calls, so a terminal prompt covers it.
 *
 * Run this on your LAPTOP, not on Railway:
 *     node linkEA.js
 * then copy the resulting ea.json onto the Railway volume.
 *
 * Ported from snallabot-service (MIT License, Copyright (c) snallabot):
 * src/dashboard/routes.ts
 */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  EA_LOGIN_URL,
  AUTH_SOURCE,
  CLIENT_SECRET,
  CLIENT_ID,
  REDIRECT_URL,
  MACHINE_KEY,
  MOBILE_UA,
  BROWSER_UA,
  VALID_ENTITLEMENTS,
  ENTITLEMENT_TO_SYSTEM,
  ENTITLEMENT_TO_VALID_NAMESPACE,
  NAMESPACES,
} from "./eaConstants.js";
import { createEAClient } from "./eaClient.js";
import { saveConnection, STORE_PATH } from "./eaTokenStore.js";

const jsonHeaders = {
  "Accept-Charset": "UTF-8",
  "User-Agent": MOBILE_UA,
  "Accept-Encoding": "gzip",
};

async function ask(rl, question, choices) {
  choices.forEach((c, i) => console.log(`  [${i + 1}] ${c.label}`));
  while (true) {
    const answer = await rl.question(`${question} `);
    const idx = Number(answer.trim()) - 1;
    if (Number.isInteger(idx) && choices[idx]) return choices[idx].value;
    console.log("  Not a valid choice, try again.");
  }
}

async function main() {
  const rl = readline.createInterface({ input, output });

  console.log("\n=== Step 1: log in to EA ===\n");
  console.log("Open this URL in a browser (use incognito if you have multiple EA accounts):\n");
  console.log(EA_LOGIN_URL + "\n");
  console.log("After logging in, the browser will fail to load a page at 127.0.0.1.");
  console.log("That is expected. Copy the FULL URL from the address bar.\n");

  const rawCode = await rl.question("Paste the 127.0.0.1 URL here: ");
  const code = new URLSearchParams(rawCode.substring(rawCode.indexOf("?"))).get("code");
  if (!code) throw new Error(`No ?code= found in that URL. Expected ${REDIRECT_URL}?code=...`);

  // The login code is single use — a failure here usually means the URL was
  // already submitted once. Go back and log in again for a fresh one.
  const tokenRes = await fetch("https://accounts.ea.com/connect/token", {
    method: "POST",
    headers: { ...jsonHeaders, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body:
      `authentication_source=${AUTH_SOURCE}&client_secret=${CLIENT_SECRET}` +
      `&grant_type=authorization_code&code=${code}&redirect_uri=${REDIRECT_URL}` +
      `&release_type=prod&client_id=${CLIENT_ID}`,
  });
  if (!tokenRes.ok) throw new Error(`Login code rejected by EA: ${await tokenRes.text()}`);
  const { access_token } = await tokenRes.json();

  console.log("\n=== Step 2: find your Madden personas ===\n");

  const pidRes = await fetch(
    `https://accounts.ea.com/connect/tokeninfo?access_token=${access_token}`,
    { headers: { ...jsonHeaders, "X-Include-Deviceid": "true" } }
  );
  if (!pidRes.ok) throw new Error(`Could not read account info: ${await pidRes.text()}`);
  const { pid_id: pid } = await pidRes.json();

  const entRes = await fetch(
    `https://gateway.ea.com/proxy/identity/pids/${pid}/entitlements/?status=ACTIVE`,
    { headers: { ...jsonHeaders, "X-Expand-Results": "true", Authorization: `Bearer ${access_token}` } }
  );
  if (!entRes.ok) throw new Error(`Could not read entitlements: ${await entRes.text()}`);
  const { entitlements: { entitlement = [] } = {} } = await entRes.json();

  const valid = entitlement.filter(
    (e) =>
      e.entitlementTag === "ONLINE_ACCESS" &&
      Object.values(VALID_ENTITLEMENTS).includes(e.groupName)
  );
  if (!valid.length) {
    throw new Error(
      "This EA account has no Madden entitlement. Wrong account, or Madden isn't linked to it: " +
        "https://myaccount.ea.com/cp-ui/connectaccounts/index"
    );
  }

  const personaLists = await Promise.all(
    valid.map(async (e) => {
      const res = await fetch(
        `https://gateway.ea.com/proxy/identity${e.pidUri}/personas?status=ACTIVE&access_token=${access_token}`,
        { headers: { ...jsonHeaders, "X-Expand-Results": "true" } }
      );
      if (!res.ok) throw new Error(`Could not read personas: ${await res.text()}`);
      const { personas: { persona = [] } = {} } = await res.json();
      return persona.map((p) => ({ ...p, maddenEntitlement: e.groupName }));
    })
  );

  // A persona only counts if its namespace matches the platform entitlement.
  const personas = personaLists
    .flat()
    .filter((p) => ENTITLEMENT_TO_VALID_NAMESPACE[p.maddenEntitlement] === p.namespaceName);
  if (!personas.length) throw new Error("No Madden personas found on this EA account.");

  const persona = await ask(
    rl,
    "Which persona?",
    personas.map((p) => ({
      label: `${p.displayName} (${NAMESPACES[p.namespaceName] || p.namespaceName})`,
      value: p,
    }))
  );

  console.log("\n=== Step 3: get a persona-scoped token ===\n");

  /*
   * Second OAuth round. The token from step 1 identifies the EA ACCOUNT;
   * Blaze needs one scoped to a specific PERSONA. We re-hit /connect/auth
   * with redirect: "manual" and read the code straight off the Location
   * header, because following the redirect would try to reach 127.0.0.1.
   */
  const redirectRes = await fetch(
    `https://accounts.ea.com/connect/auth?hide_create=true&release_type=prod&response_type=code` +
      `&redirect_uri=${REDIRECT_URL}&client_id=${CLIENT_ID}&machineProfileKey=${MACHINE_KEY}` +
      `&authentication_source=${AUTH_SOURCE}&access_token=${access_token}` +
      `&persona_id=${persona.personaId}&persona_namespace=${persona.namespaceName}`,
    {
      redirect: "manual",
      headers: {
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "X-Requested-With": "com.ea.gp.madden19companionapp",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "en-US,en;q=0,9",
      },
    }
  );

  const location = redirectRes.headers.get("Location");
  if (!location) throw new Error("EA did not return a persona redirect. Try relinking.");
  const personaCode = new URLSearchParams(location.replace(REDIRECT_URL, "")).get("code");
  if (!personaCode) throw new Error(`No code in persona redirect: ${location}`);

  const finalRes = await fetch("https://accounts.ea.com/connect/token", {
    method: "POST",
    headers: { ...jsonHeaders, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body:
      `authentication_source=${AUTH_SOURCE}&code=${personaCode}&grant_type=authorization_code` +
      `&token_format=JWS&release_type=prod&client_secret=${CLIENT_SECRET}` +
      `&redirect_uri=${REDIRECT_URL}&client_id=${CLIENT_ID}`,
  });
  if (!finalRes.ok) throw new Error(`Could not mint persona token: ${await finalRes.text()}`);
  const finalToken = await finalRes.json();

  const token = {
    accessToken: finalToken.access_token,
    refreshToken: finalToken.refresh_token,
    expiry: new Date(Date.now() + finalToken.expires_in * 1000).toISOString(),
    console: ENTITLEMENT_TO_SYSTEM[persona.maddenEntitlement],
    blazeId: `${persona.personaId}`,
  };

  console.log("\n=== Step 4: pick the league ===\n");

  const client = await createEAClient(token);
  const leagues = await client.getLeagues();
  if (!leagues.length) throw new Error("No Madden leagues on this persona.");

  const league = await ask(
    rl,
    "Which league?",
    leagues.map((l) => ({
      label: `${l.leagueName} — ${l.userTeamName} (id ${l.leagueId})`,
      value: l,
    }))
  );

  await saveConnection({
    token: { ...token, session: undefined },
    leagueId: league.leagueId,
    leagueName: league.leagueName,
  });

  console.log(`\nLinked "${league.leagueName}" (id ${league.leagueId}).`);
  console.log(`Credentials written to ${STORE_PATH}\n`);
  console.log("Next: copy that file to the Railway volume at the same path,");
  console.log("and set MADDEN_EXPORT_URL to your maddenWebhook endpoint.\n");
  console.log("Treat this file like a password — it is a live EA credential.\n");

  rl.close();
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  if (e.troubleshoot) console.error(`Hint: ${e.troubleshoot}`);
  process.exit(1);
});
