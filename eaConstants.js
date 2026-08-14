/*
 * EA / Blaze constants.
 *
 * Ported from snallabot-service (MIT License, Copyright (c) snallabot)
 * https://github.com/snallabot/snallabot-service/blob/main/src/dashboard/ea_constants.ts
 *
 * ------------------------------------------------------------------
 * THIS FILE ROTS. When EA ships a new Madden or rotates credentials,
 * the values below go stale and every EA call starts failing with auth
 * errors. Recovery = diff this file against upstream ea_constants.ts.
 * The usual suspects, in order of likelihood:
 *   CLIENT_SECRET (note the date suffix), TWO_DIGIT_YEAR, YEAR,
 *   CLIENT_ID, MACHINE_KEY.
 * ------------------------------------------------------------------
 */

// --- Madden version -------------------------------------------------
// Bump both when the league moves to a new Madden.
const TWO_DIGIT_YEAR = "26";
const YEAR = "2026";

// --- OAuth ----------------------------------------------------------
const AUTH_SOURCE = 317239;
const CLIENT_SECRET =
  "teJpJ9cSXFqZAuKNW8IuHpy8D4dwWPoVrPoek38iCnrGbrUSfjqnHMBAv8iCVjeSm_20250910175618";
const REDIRECT_URL = "http://127.0.0.1/success";
const CLIENT_ID = `MCA_${TWO_DIGIT_YEAR}_COMP_APP`;
const MACHINE_KEY = "444d362e8e067fe2";

const EA_LOGIN_URL =
  `https://accounts.ea.com/connect/auth?hide_create=true&release_type=prod` +
  `&response_type=code&redirect_uri=${REDIRECT_URL}&client_id=${CLIENT_ID}` +
  `&machineProfileKey=${MACHINE_KEY}&authentication_source=${AUTH_SOURCE}`;

// The companion app's user agent. EA rejects unknown clients, so don't
// "clean this up" — it is load bearing.
const MOBILE_UA =
  "Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/103.0.5060.71 Mobile Safari/537.36";

// --- Consoles / entitlements ----------------------------------------
const SystemConsole = {
  XBOX_ONE: "xone",
  PS4: "ps4",
  PC: "pc",
  PS5: "ps5",
  XBOX_X: "xbsx",
  STADIA: "stadia",
};

const VALID_ENTITLEMENTS = {
  xone: `MADDEN_${TWO_DIGIT_YEAR}XONE`,
  ps4: `MADDEN_${TWO_DIGIT_YEAR}PS4`,
  pc: `MADDEN_${TWO_DIGIT_YEAR}PC`,
  ps5: `MADDEN_${TWO_DIGIT_YEAR}PS5`,
  xbsx: `MADDEN_${TWO_DIGIT_YEAR}XBSX`,
  stadia: `MADDEN_${TWO_DIGIT_YEAR}SDA`,
};

const ENTITLEMENT_TO_SYSTEM = {
  [`MADDEN_${TWO_DIGIT_YEAR}XONE`]: SystemConsole.XBOX_ONE,
  [`MADDEN_${TWO_DIGIT_YEAR}PS4`]: SystemConsole.PS4,
  [`MADDEN_${TWO_DIGIT_YEAR}PC`]: SystemConsole.PC,
  [`MADDEN_${TWO_DIGIT_YEAR}PS5`]: SystemConsole.PS5,
  [`MADDEN_${TWO_DIGIT_YEAR}XBSX`]: SystemConsole.XBOX_X,
  [`MADDEN_${TWO_DIGIT_YEAR}SDA`]: SystemConsole.STADIA,
};

// The persona namespace EA expects per platform. A persona whose
// namespaceName doesn't match its entitlement is not a Madden persona.
const ENTITLEMENT_TO_VALID_NAMESPACE = {
  [`MADDEN_${TWO_DIGIT_YEAR}XONE`]: "xbox",
  [`MADDEN_${TWO_DIGIT_YEAR}PS4`]: "ps3",
  [`MADDEN_${TWO_DIGIT_YEAR}PC`]: "cem_ea_id",
  [`MADDEN_${TWO_DIGIT_YEAR}PS5`]: "ps3",
  [`MADDEN_${TWO_DIGIT_YEAR}XBSX`]: "xbox",
  [`MADDEN_${TWO_DIGIT_YEAR}SDA`]: "stadia",
};

const NAMESPACES = {
  xbox: "XBOX",
  ps3: "PSN",
  cem_ea_id: "EA Account",
  stadia: "Stadia",
};

// --- Blaze ----------------------------------------------------------
const BLAZE_SERVICE = {
  xone: `madden-${YEAR}-xone`,
  ps4: `madden-${YEAR}-ps4`,
  pc: `madden-${YEAR}-pc`,
  ps5: `madden-${YEAR}-ps5`,
  xbsx: `madden-${YEAR}-xbsx`,
  stadia: `madden-${YEAR}-stadia`,
};

const BLAZE_PRODUCT_NAME = {
  xone: `madden-${YEAR}-xone-mca`,
  ps4: `madden-${YEAR}-ps4-mca`,
  pc: `madden-${YEAR}-pc-mca`,
  ps5: `madden-${YEAR}-ps5-mca`,
  xbsx: `madden-${YEAR}-xbsx-mca`,
  stadia: `madden-${YEAR}-stadia-mca`,
};

const BLAZE_BASE = "https://wal2.tools.gos.bio-iad.ea.com/wal";

// --- Export endpoints -----------------------------------------------
const LeagueData = {
  TEAMS: "CareerMode_GetLeagueTeamsExport",
  STANDINGS: "CareerMode_GetStandingsExport",
  WEEKLY_SCHEDULE: "CareerMode_GetWeeklySchedulesExport",
  RUSHING_STATS: "CareerMode_GetWeeklyRushingStatsExport",
  TEAM_STATS: "CareerMode_GetWeeklyTeamStatsExport",
  PUNTING_STATS: "CareerMode_GetWeeklyPuntingStatsExport",
  RECEIVING_STATS: "CareerMode_GetWeeklyReceivingStatsExport",
  DEFENSIVE_STATS: "CareerMode_GetWeeklyDefensiveStatsExport",
  KICKING_STATS: "CareerMode_GetWeeklyKickingStatsExport",
  PASSING_STATS: "CareerMode_GetWeeklyPassingStatsExport",
  TEAM_ROSTER: "CareerMode_GetTeamRostersExport",
};

const Stage = { PRESEASON: 0, SEASON: 1 };

// Week 21 is the Pro Bowl — Madden has no exportable data for it.
const PRESEASON_WEEKS = [0, 1, 2, 3];
const SEASON_WEEKS = Array.from({ length: 23 }, (_, i) => i).filter((i) => i !== 21);

export {
  TWO_DIGIT_YEAR,
  YEAR,
  AUTH_SOURCE,
  CLIENT_SECRET,
  REDIRECT_URL,
  CLIENT_ID,
  MACHINE_KEY,
  EA_LOGIN_URL,
  MOBILE_UA,
  BROWSER_UA,
  SystemConsole,
  VALID_ENTITLEMENTS,
  ENTITLEMENT_TO_SYSTEM,
  ENTITLEMENT_TO_VALID_NAMESPACE,
  NAMESPACES,
  BLAZE_SERVICE,
  BLAZE_PRODUCT_NAME,
  BLAZE_BASE,
  LeagueData,
  Stage,
  PRESEASON_WEEKS,
  SEASON_WEEKS,
};
