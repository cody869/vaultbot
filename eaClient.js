/*
 * EA Blaze client — token refresh, session handling, and the 12 export calls.
 *
 * Ported from snallabot-service (MIT License, Copyright (c) snallabot)
 * https://github.com/snallabot/snallabot-service/blob/main/src/dashboard/ea_client.ts
 *
 * This file is deliberately storage-free. It takes a token object in and
 * hands data back; persistence lives in eaTokenStore.js.
 */

import { Agent, fetch } from "undici";
import { constants, randomBytes, createHash } from "node:crypto";

import {
  AUTH_SOURCE,
  CLIENT_SECRET,
  CLIENT_ID,
  MACHINE_KEY,
  MOBILE_UA,
  BLAZE_SERVICE,
  BLAZE_PRODUCT_NAME,
  BLAZE_BASE,
  LeagueData,
} from "./eaConstants.js";

class EAAccountError extends Error {
  constructor(message, troubleshoot) {
    super(message);
    this.name = "EAAccountError";
    this.troubleshoot = troubleshoot || "No guidance";
  }
}

class BlazeError extends Error {
  constructor(error) {
    super(JSON.stringify(error));
    this.name = "BlazeError";
    this.error = error;
  }
}

/*
 * EA's Blaze endpoints are still on legacy SSL renegotiation, which Node
 * rejects by default. This is why we use undici's fetch with a custom
 * dispatcher rather than global fetch — swapping it back will produce
 * opaque handshake failures.
 */
const dispatcher = new Agent({
  connect: {
    rejectUnauthorized: false,
    secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
  },
});

const blazeHeaders = (token) => ({
  "Accept-Charset": "UTF-8",
  Accept: "application/json",
  "X-BLAZE-ID": BLAZE_SERVICE[token.console],
  "X-BLAZE-VOID-RESP": "XML",
  "X-Application-Key": "MADDEN-MCA",
  "Content-Type": "application/json",
  "User-Agent": MOBILE_UA,
});

/**
 * Exchange the refresh token for a fresh access token, but only if the
 * current one has actually expired.
 *
 * IMPORTANT: EA rotates BOTH tokens on every refresh. The returned
 * refreshToken must be persisted or the chain is broken and the league
 * has to be re-linked from a browser. Never run two of these concurrently.
 *
 * @returns {Promise<object>} a token object (possibly the same one)
 */
async function refreshToken(token) {
  if (new Date() <= new Date(token.expiry)) return token;

  const res = await fetch("https://accounts.ea.com/connect/token", {
    method: "POST",
    headers: {
      "Accept-Charset": "UTF-8",
      "User-Agent": MOBILE_UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Accept-Encoding": "gzip",
    },
    body:
      `grant_type=refresh_token&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}` +
      `&release_type=prod&refresh_token=${token.refreshToken}` +
      `&authentication_source=${AUTH_SOURCE}&token_format=JWS`,
  });

  const newToken = await res.json();
  if (!res.ok || !newToken.access_token) {
    throw new EAAccountError(
      `Error refreshing EA tokens: ${JSON.stringify(newToken)}`,
      "The EA connection is dead. Re-run `node scripts/linkEA.js` to relink."
    );
  }

  return {
    accessToken: newToken.access_token,
    refreshToken: newToken.refresh_token,
    expiry: new Date(Date.now() + newToken.expires_in * 1000).toISOString(),
    console: token.console,
    blazeId: `${token.blazeId}`,
  };
}

/** Log in to Blaze and get a session key. */
async function retrieveBlazeSession(token) {
  const res = await fetch(`${BLAZE_BASE}/authentication/login`, {
    dispatcher,
    method: "POST",
    headers: blazeHeaders(token),
    body: JSON.stringify({
      accessToken: token.accessToken,
      productName: BLAZE_PRODUCT_NAME[token.console],
    }),
  });

  const text = await res.text();
  try {
    const session = JSON.parse(text);
    return {
      blazeId: session.userLoginInfo.personaDetails.personaId,
      sessionKey: session.userLoginInfo.sessionKey,
      requestId: 1,
    };
  } catch (e) {
    throw new EAAccountError(
      `Could not connect to EA Blaze. Response: ${text}`,
      "Often temporary (EA side). If it persists, relink with scripts/linkEA.js."
    );
  }
}

/*
 * Reverse-engineered request signing from the Madden companion app: a
 * random 4-byte prefix, an MD5-derived XOR keystream over the request
 * JSON, then an MD5 of a static salt plus the scrambled bytes.
 *
 * The magic hex strings are not derivable from anything — do not touch
 * them. If EA changes this scheme, every Blaze call starts failing at
 * once and the fix comes from upstream.
 */
function calculateMessageAuthData(blazeId, requestId) {
  const rand4bytes = randomBytes(4);
  const requestData = JSON.stringify({
    staticData: "05e6a7ead5584ab4",
    requestId,
    blazeId,
  });
  const staticBytes = Buffer.from("634203362017bf72f70ba900c0aa4e6b", "hex");

  const xorHash = createHash("md5").update(rand4bytes).update(staticBytes).digest();
  const requestBuffer = Buffer.from(requestData, "utf-8");
  const scrambledBytes = requestBuffer.map((b, i) => b ^ xorHash[i % 16]);
  const authDataBytes = Buffer.concat([rand4bytes, scrambledBytes]);

  const staticAuthCode = Buffer.from("3a53413521464c3b6531326530705b70203a2900", "hex");
  const authCode = createHash("md5")
    .update(staticAuthCode)
    .update(authDataBytes)
    .digest("base64");

  return {
    authData: authDataBytes.toString("base64"),
    authCode,
    authType: 17039361,
  };
}

async function sendBlazeRequest(token, session, request) {
  const authData = calculateMessageAuthData(session.blazeId, session.requestId);
  const { requestPayload, ...rest } = request;

  const body = {
    apiVersion: 2,
    clientDevice: 3,
    requestInfo: JSON.stringify({
      ...rest,
      messageAuthData: authData,
      messageExpirationTime: Math.floor(Date.now() / 1000),
      deviceId: MACHINE_KEY,
      ipAddress: "127.0.0.1",
      requestPayload: JSON.stringify(requestPayload),
    }),
  };

  const res = await fetch(`${BLAZE_BASE}/mca/Process/${session.sessionKey}`, {
    dispatcher,
    method: "POST",
    headers: blazeHeaders(token),
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new EAAccountError(`Failed to send Blaze request. Response: ${text}`);
  }
  if (parsed.error) throw new BlazeError(parsed);
  return parsed;
}

/**
 * Fetch one export payload. EA returns ERR_TIMEOUT under load fairly
 * often on big leagues, so this backs off and retries rather than
 * failing the whole export.
 */
async function getExportData(token, session, exportType, body, retries = 5, baseDelayMs = 1000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`${BLAZE_BASE}/mca/${exportType}/${session.sessionKey}`, {
      dispatcher,
      method: "POST",
      headers: blazeHeaders(token),
      body: JSON.stringify(body),
    });

    let parsed;
    try {
      const text = await res.text();
      // Madden export payloads contain raw control characters that make
      // JSON.parse choke — strip them before parsing.
      parsed = JSON.parse(text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
    } catch (e) {
      throw new EAAccountError(`Could not fetch league data: ${e}`);
    }

    if (parsed && typeof parsed === "object" && parsed.error) {
      if (parsed.error.errorname === "ERR_TIMEOUT" && attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
        continue;
      }
      // Any EA-side error response (not just ERR_TIMEOUT, and ERR_TIMEOUT
      // once retries are exhausted) must never be returned as if it were
      // data. Confirmed live: an unhandled error shape here silently made
      // it all the way through the export pipeline and got POSTed to the
      // destination as "defense stats" -- which correctly rejected it with
      // 400 "Could not detect payload type" since it obviously wasn't.
      throw new BlazeError(parsed);
    }

    return parsed;
  }
  throw new EAAccountError(`EA request failed after ${retries} attempts`);
}

/** Cheap probe: if the session is stale, Blaze errors and we re-login. */
async function refreshBlazeSession(token, session) {
  try {
    await sendBlazeRequest(token, session, {
      commandName: "Mobile_GetMyLeagues",
      componentId: 2060,
      commandId: 801,
      requestPayload: {},
      componentName: "franchisemode",
    });
    return session;
  } catch (e) {
    if (e instanceof BlazeError) {
      const fresh = await retrieveBlazeSession(token);
      return { ...fresh, requestId: session.requestId };
    }
    throw e;
  }
}

/**
 * Build a client bound to a specific token + session.
 * Every method here maps 1:1 to a companion-app call.
 */
async function createEAClient(token, session) {
  const validSession = session || (await retrieveBlazeSession(token));
  const weekly = (type) => (leagueId, stage, weekIndex) =>
    getExportData(token, validSession, type, { leagueId, stageIndex: stage, weekIndex });

  return {
    getSystemConsole: () => token.console,
    getSession: () => validSession,

    async getLeagues() {
      const res = await sendBlazeRequest(token, validSession, {
        commandName: "Mobile_GetMyLeagues",
        componentId: 2060,
        commandId: 801,
        requestPayload: {},
        componentName: "franchisemode",
      });
      return res.responseInfo.value.leagues;
    },

    async getLeagueInfo(leagueId) {
      const res = await sendBlazeRequest(token, validSession, {
        commandName: "Mobile_Career_GetLeagueHub",
        componentId: 2060,
        commandId: 811,
        requestPayload: { leagueId },
        componentName: "franchisemode",
      });
      return res.responseInfo.value;
    },

    getTeams: (leagueId) =>
      getExportData(token, validSession, LeagueData.TEAMS, { leagueId }),
    getStandings: (leagueId) =>
      getExportData(token, validSession, LeagueData.STANDINGS, { leagueId }),

    getSchedules: weekly(LeagueData.WEEKLY_SCHEDULE),
    getRushingStats: weekly(LeagueData.RUSHING_STATS),
    getTeamStats: weekly(LeagueData.TEAM_STATS),
    getPuntingStats: weekly(LeagueData.PUNTING_STATS),
    getReceivingStats: weekly(LeagueData.RECEIVING_STATS),
    getDefensiveStats: weekly(LeagueData.DEFENSIVE_STATS),
    getKickingStats: weekly(LeagueData.KICKING_STATS),
    getPassingStats: weekly(LeagueData.PASSING_STATS),

    // teamIndex is the team's position in leagueInfo.teamIdInfoList, not its id
    getTeamRoster: (leagueId, teamId, teamIndex) =>
      getExportData(token, validSession, LeagueData.TEAM_ROSTER, {
        leagueId,
        listIndex: teamIndex,
        returnFreeAgents: false,
        teamId,
      }),

    getFreeAgents: (leagueId) =>
      getExportData(token, validSession, LeagueData.TEAM_ROSTER, {
        leagueId,
        listIndex: -1,
        returnFreeAgents: true,
        teamId: 0,
      }),

    /*
     * Franchise admin write commands. componentId=2060 is confirmed (same
     * component getLeagues/getLeagueInfo above use). commandId=0 is
     * UNVERIFIED — the two commandIds we could independently confirm
     * (Mobile_GetMyLeagues=801, Mobile_Career_GetLeagueHub=811) are NOT 0,
     * so this is an open question, not settled. Payload field names are
     * decompiled from the app itself (AdminAction_PostBody,
     * ClearCapPenalties_PostBody, ForceResult_PostBody,
     * ToggleAutoPilot_PostBody — namespace MCA.DataContainers) and should
     * be solid regardless of how the commandId question shakes out.
     * Test toggleAutoPilot first — reversible, visible in-app.
     */
    bootUser: (leagueId, bootedUserId) =>
      sendBlazeRequest(token, validSession, {
        commandName: "Mobile_UserAdmin_BootUser",
        componentId: 2060,
        commandId: 0,
        requestPayload: { leagueId, bootedUserId },
        componentName: "franchisemode",
      }),

    addAdmin: (leagueId, newAdminUserId) =>
      sendBlazeRequest(token, validSession, {
        commandName: "Mobile_UserAdmin_AddAdmin",
        componentId: 2060,
        commandId: 0,
        requestPayload: { leagueId, newAdminUserId },
        componentName: "franchisemode",
      }),

    removeAdmin: (leagueId, newAdminUserId) =>
      sendBlazeRequest(token, validSession, {
        commandName: "Mobile_UserAdmin_RemoveAdmin",
        componentId: 2060,
        commandId: 0,
        requestPayload: { leagueId, newAdminUserId },
        componentName: "franchisemode",
      }),

    clearCapPenalties: (leagueId, clearedUserId) =>
      sendBlazeRequest(token, validSession, {
        commandName: "Mobile_UserAdmin_ClearCapPenalties",
        componentId: 2060,
        commandId: 0,
        requestPayload: { leagueId, clearedUserId },
        componentName: "franchisemode",
      }),

    toggleAutoPilot: (leagueId, toggleAutoPilotUserId, actionTimeout = 0) =>
      sendBlazeRequest(token, validSession, {
        commandName: "Mobile_UserAdmin_ToggleAutoPilot",
        componentId: 2060,
        commandId: 0,
        requestPayload: { leagueId, actionTimeout, ToggleAutoPilotUserId: toggleAutoPilotUserId },
        componentName: "franchisemode",
      }),

    forceHomeWin: (leagueId, seasonGameKey) =>
      sendBlazeRequest(token, validSession, {
        commandName: "Mobile_GameSchedule_ForceHomeWin",
        componentId: 2060,
        commandId: 0,
        requestPayload: { leagueId, seasonGameKey },
        componentName: "franchisemode",
      }),

    forceAwayWin: (leagueId, seasonGameKey) =>
      sendBlazeRequest(token, validSession, {
        commandName: "Mobile_GameSchedule_ForceAwayWin",
        componentId: 2060,
        commandId: 0,
        requestPayload: { leagueId, seasonGameKey },
        componentName: "franchisemode",
      }),

    forceNoWin: (leagueId, seasonGameKey) =>
      sendBlazeRequest(token, validSession, {
        commandName: "Mobile_GameSchedule_ForceNoWin",
        componentId: 2060,
        commandId: 0,
        requestPayload: { leagueId, seasonGameKey },
        componentName: "franchisemode",
      }),
  };
}

export {
  EAAccountError,
  BlazeError,
  refreshToken,
  retrieveBlazeSession,
  refreshBlazeSession,
  createEAClient,
};
