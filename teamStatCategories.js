// teamStatCategories.js -- the /teamstats leaderboard categories.
//
// One table shared by the slash-command choices (deploy-commands.js), the
// category dropdown (embeds.js) and the ranking itself (vault.js), so adding a
// category here is all it takes. Kept free of imports so deploy-commands.js
// can load it without pulling in vault.js (which exits without Base44 env).
//
// Each entry ranks a per-team season summary built by vault.js:
//   value(s)  -> the number ranked (null = team has no data for it)
//   low       -> smaller is better (defense allowed, giveaways, penalties)
//   fmt       -> "avg" one decimal | "int" whole number | "pct" percent | "signed" +/-N
//   detail(s) -> optional extra context shown after the team name
//
// Discord caps both slash-command choices and select-menu options at 25.

const frac = (made, att) => `${made}/${att}`;

export const TEAM_STAT_CATEGORIES = {
  // Offense
  ppg:        { label: "Points per Game",          fmt: "avg", value: (s) => s.ppg },
  ypg:        { label: "Total Yards per Game",     fmt: "avg", value: (s) => s.ypg },
  pass_ypg:   { label: "Passing Yards per Game",   fmt: "avg", value: (s) => s.passYpg },
  rush_ypg:   { label: "Rushing Yards per Game",   fmt: "avg", value: (s) => s.rushYpg },
  pass_tds:   { label: "Passing TDs",              fmt: "int", value: (s) => s.sums.off_pass_tds },
  rush_tds:   { label: "Rushing TDs",              fmt: "int", value: (s) => s.sums.off_rush_tds },
  third_down: { label: "3rd Down %",               fmt: "pct", value: (s) => s.thirdPct,
                detail: (s) => frac(s.sums.off_3rd_down_conv, s.sums.off_3rd_down_att) },
  red_zone:   { label: "Red Zone Scoring %",       fmt: "pct", value: (s) => s.rzPct,
                detail: (s) => `${s.sums.off_red_zone_tds} TD · ${s.sums.off_red_zone_fgs} FG in ${s.sums.off_red_zones}` },
  sacks_allowed: { label: "Fewest Sacks Allowed",  fmt: "int", low: true, value: (s) => s.sacksAllowed },

  // Defense
  papg:       { label: "Fewest Points Allowed",    fmt: "avg", low: true, value: (s) => s.papg },
  yapg:       { label: "Fewest Yards Allowed",     fmt: "avg", low: true, value: (s) => s.yapg },
  pass_def:   { label: "Pass Defense (Yds/G)",     fmt: "avg", low: true, value: (s) => s.passApg },
  rush_def:   { label: "Rush Defense (Yds/G)",     fmt: "avg", low: true, value: (s) => s.rushApg },
  sacks:      { label: "Sacks",                    fmt: "int", value: (s) => s.sacks },
  def_ints:   { label: "Interceptions",            fmt: "int", value: (s) => s.sums.def_ints_rec },
  red_zone_def: { label: "Red Zone Defense %",     fmt: "pct", low: true, value: (s) => s.defRzPct,
                detail: (s) => `${s.sums.def_red_zone_tds} TD · ${s.sums.def_red_zone_fgs} FG in ${s.sums.def_red_zones}` },

  // Turnovers / discipline
  takeaways:  { label: "Takeaways",                fmt: "int", value: (s) => s.takeaways },
  giveaways:  { label: "Fewest Giveaways",         fmt: "int", low: true, value: (s) => s.giveaways },
  to_diff:    { label: "Turnover Differential",    fmt: "signed", value: (s) => s.toDiff },
  penalty_ypg: { label: "Fewest Penalty Yds/G",    fmt: "avg", low: true, value: (s) => s.penYpg },
};

export const DEFAULT_TEAM_STAT_CATEGORY = "ppg";

export function formatTeamStat(fmt, v) {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (fmt) {
    case "pct": return `${v.toFixed(1)}%`;
    case "signed": return v > 0 ? `+${v}` : `${v}`;
    case "int": return Math.round(v).toLocaleString();
    default: return v.toFixed(1);
  }
}
