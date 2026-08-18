// adminActions.js
// Blaze "Franchise Admin" write commands — Madden 26 Companion App.
//
// SOURCES:
// - Auth flow, headers, message-auth signing: ea_api.md (same scheme your
//   working GetMyLeagues/GetLeagueHub calls already use)
// - Payload field names/types: decompiled from the Madden 26 Companion App
//   (AdminAction_PostBody, ClearCapPenalties_PostBody, ForceResult_PostBody,
//   ToggleAutoPilot_PostBody, Franchise_Base_PostBody — namespace MCA.DataContainers)
//
// ⚠️ commandId is UNVERIFIED (set to 0 per source; the two commandIds we
// confirmed independently — GetMyLeagues=801, GetLeagueHub=811 — are NOT 0,
// so this is a real open question, not a settled one). Test toggleAutoPilot
// first — it's reversible and visible in-app — before trusting the rest.

import crypto from 'crypto';

const ADMIN_COMMANDS = {
  bootUser: { commandName: 'Mobile_UserAdmin_BootUser', componentId: 2060, commandId: 0, componentName: 'careermode' },
  addAdmin: { commandName: 'Mobile_UserAdmin_AddAdmin', componentId: 2060, commandId: 0, componentName: 'careermode' },
  removeAdmin: { commandName: 'Mobile_UserAdmin_RemoveAdmin', componentId: 2060, commandId: 0, componentName: 'careermode' },
  clearCapPenalties: { commandName: 'Mobile_UserAdmin_ClearCapPenalties', componentId: 2060, commandId: 0, componentName: 'careermode' },
  toggleAutoPilot: { commandName: 'Mobile_UserAdmin_ToggleAutoPilot', componentId: 2060, commandId: 0, componentName: 'careermode' },
  forceHomeWin: { commandName: 'Mobile_GameSchedule_ForceHomeWin', componentId: 2060, commandId: 0, componentName: 'careermode' },
  forceAwayWin: { commandName: 'Mobile_GameSchedule_ForceAwayWin', componentId: 2060, commandId: 0, componentName: 'careermode' },
  forceNoWin: { commandName: 'Mobile_GameSchedule_ForceNoWin', componentId: 2060, commandId: 0, componentName: 'careermode' },
};

function buildMessageAuth(requestId, blazeId) {
  const staticBytes = Buffer.from('634203362017bf72f70ba900c0aa4e6b', 'hex');
  const staticAuthCode = Buffer.from('3a53413521464c3b6531326530705b70203a2900', 'hex');

  const rand4 = crypto.randomBytes(4);
  const payload = JSON.stringify({ staticData: '05e6a7ead5584ab4', requestId, blazeId });
  const payloadBytes = Buffer.from(payload, 'utf-8');

  const md5Key = crypto.createHash('md5').update(Buffer.concat([rand4, staticBytes])).digest();
  const xored = Buffer.alloc(payloadBytes.length);
  for (let i = 0; i < payloadBytes.length; i++) {
    xored[i] = payloadBytes[i] ^ md5Key[i % md5Key.length];
  }

  const authDataBytes = Buffer.concat([rand4, xored]);
  return {
    authData: authDataBytes.toString('base64'),
    authCode: crypto.createHash('md5').update(Buffer.concat([staticAuthCode, authDataBytes])).digest('base64'),
    authType: 17039361,
  };
}

// session = { sessionKey, blazeId, deviceId, blazeIdHeader }
// blazeIdHeader is the X-BLAZE-ID value for whatever platform this league's
// stored session actually logged in as (e.g. 'madden-2026-ps5') — pull this
// from wherever your existing EA export code keeps it, don't hardcode a
// platform here since leagues span platforms.
async function callBlazeAdminCommand(session, command, requestPayload) {
  const requestId = Math.floor(Math.random() * 1_000_000);
  const messageAuthData = buildMessageAuth(requestId, session.blazeId);

  const requestInfo = {
    commandName: command.commandName,
    componentId: command.componentId,
    commandId: command.commandId,
    componentName: command.componentName,
    messageAuthData,
    messageExpirationTime: Math.floor(Date.now() / 1000) + 300,
    deviceId: session.deviceId,
    ipAddress: '127.0.0.1',
    requestPayload: JSON.stringify(requestPayload),
  };

  const body = {
    apiVersion: 2,
    clientDevice: 3,
    requestInfo: JSON.stringify(requestInfo),
  };

  const res = await fetch(`https://wal2.tools.gos.bio-iad.ea.com/wal/mca/Process/${session.sessionKey}`, {
    method: 'POST',
    headers: {
      'Accept-Charset': 'UTF-8',
      'Accept': 'application/json',
      'X-BLAZE-ID': session.blazeIdHeader,
      'X-BLAZE-VOID-RESP': 'XML',
      'X-Application-Key': 'MADDEN-MCA',
      'Content-Type': 'application/json',
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Blaze admin command ${command.commandName} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function bootUser(session, leagueId, targetUserId) {
  return callBlazeAdminCommand(session, ADMIN_COMMANDS.bootUser, { leagueId, bootedUserId: targetUserId });
}

export async function addAdmin(session, leagueId, targetUserId) {
  return callBlazeAdminCommand(session, ADMIN_COMMANDS.addAdmin, { leagueId, newAdminUserId: targetUserId });
}

export async function removeAdmin(session, leagueId, targetUserId) {
  return callBlazeAdminCommand(session, ADMIN_COMMANDS.removeAdmin, { leagueId, newAdminUserId: targetUserId });
}

export async function clearCapPenalties(session, leagueId, targetUserId) {
  return callBlazeAdminCommand(session, ADMIN_COMMANDS.clearCapPenalties, { leagueId, clearedUserId: targetUserId });
}

export async function toggleAutoPilot(session, leagueId, targetUserId, actionTimeoutSeconds = 0) {
  return callBlazeAdminCommand(session, ADMIN_COMMANDS.toggleAutoPilot, {
    leagueId,
    actionTimeout: actionTimeoutSeconds,
    ToggleAutoPilotUserId: targetUserId,
  });
}

export async function forceHomeWin(session, leagueId, seasonGameKey) {
  return callBlazeAdminCommand(session, ADMIN_COMMANDS.forceHomeWin, { leagueId, seasonGameKey });
}

export async function forceAwayWin(session, leagueId, seasonGameKey) {
  return callBlazeAdminCommand(session, ADMIN_COMMANDS.forceAwayWin, { leagueId, seasonGameKey });
}

export async function forceNoWin(session, leagueId, seasonGameKey) {
  return callBlazeAdminCommand(session, ADMIN_COMMANDS.forceNoWin, { leagueId, seasonGameKey });
}
