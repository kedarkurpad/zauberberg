#!/usr/bin/env node
/**
 * Fetches ticker indicators server-side (so API keys never touch the browser)
 * and writes /ticker-data.json for the static page to read. Also fetches the
 * Energy module's generation-mix chart dataset and writes /energy-data.json
 * alongside it, the Distributional Justice module's US Gini time series,
 * writing /gini-data.json, the Structural Power module's Student Loans
 * Owned and Securitized time series, writing /student-loan-data.json, the
 * Peace and Conflict module's forcibly-displaced-persons-by-region
 * breakdown, writing /peace-data.json, the discourse-tagging module's
 * lexicon-scored Congressional Record excerpts, writing /discourse-data.json
 * (see DECISIONS.md, "Discourse-tagging module"), the Democracy
 * module's US Liberal Democracy Index (V-Dem, via OWID) time series,
 * writing /democracy-data.json (see DECISIONS.md, "Democracy module"),
 * and the Legal case-narrative tagging module's lexicon-scored SEC EDGAR
 * Legal Proceedings excerpts, writing /legal-data.json (additive to, not
 * a replacement for, the discourse-tagging module \u2014 see DECISIONS.md,
 * "Legal case-narrative tagging module").
 *
 * NOTE: crude-oil-imports-by-country-of-origin (fetchCrudeImports and its
 * treemap) was removed 2026-09-11 by request \u2014 see DECISIONS.md changelog.
 * energy-data.json now carries only generationMix.
 *
 * Run by .github/workflows/update-ticker-data.yml on a schedule.
 *
 * Secrets expected in the repo (Settings -> Secrets and variables -> Actions):
 *   FRED_API_KEY   - https://fredaccount.stlouisfed.org/apikeys (free)
 *   BLS_API_KEY    - https://data.bls.gov/registrationEngine/ (free, optional —
 *                    script falls back to unauthenticated calls at a lower quota)
 *   CENSUS_API_KEY - https://api.census.gov/data/key_signup.html (free, optional —
 *                    currently unused by the active pipeline; see fetchGini/
 *                    fetchIncomeGap below)
 *   EIA_API_KEY    - https://www.eia.gov/opendata/register.php (free, REQUIRED
 *                    for fetchSPR \u2014 EIA does not offer an unauthenticated
 *                    fallback the way BLS/Census do)
 *   GOVINFO_API_KEY - https://api.govinfo.gov/docs/ (free, OPTIONAL \u2014 GovInfo
 *                    accepts the shared, unregistered "DEMO_KEY" at a low rate
 *                    limit (30/hr, 50/day per api.data.gov's shared quota) for
 *                    fetchDiscourseTags(). Register for a personal key only if
 *                    the demo quota turns out to be too tight for the daily
 *                    schedule \u2014 see DECISIONS.md, "Discourse-tagging module".)
 *
 * Design notes (see DECISIONS.md, Technical Requirements):
 *   - Wired up and in the core ticker: FRED (T10Y2Y, labor share, Nominal
 *     Broad Dollar Index, WTI 20-day realized volatility, US home-price
 *     YoY growth), BLS (unemployment gap), OWID/WID (global top 1% wealth
 *     share, US top 1% income share), EIA (Strategic Petroleum
 *     Reserve), UNHCR (forcibly displaced persons, global total). GDELT
 *     tone was dropped by request \u2014 see DECISIONS.md changelog. Tier 2
 *     (ECB spread, OFAC additions, EU ETS/Ember) is intentionally
 *     deferred.
 *   - Energy module (separate output, energy-data.json, not the ticker):
 *     fetchGenerationMix(), EIA, reusing the existing EIA_API_KEY (no new
 *     secret). Written without a live test call (no network egress in this
 *     sandbox) \u2014 verify the first real run's response shape before
 *     trusting it unattended; see the CAVEAT comment on the function.
 *     (fetchCrudeImports() and its treemap were removed 2026-09-11 by
 *     request \u2014 see DECISIONS.md changelog.)
 *   - Core ticker also gained fetchEnergyVolatility() (FRED DCOILWTICO,
 *     WTI crude), a Pillar 4 leverage-framed indicator: 20-trading-day
 *     realized volatility of the WTI spot price, not the price level
 *     itself \u2014 volatility/swings are read as exposure to supply-chain
 *     and geopolitical shocks (Klein; Riofrancos; Malm; Mitchell), the
 *     same leverage logic already used for the SPR indicator, whereas a
 *     bare price level would fail the Pillar 4 relevance test as plain
 *     supply-and-demand economics. See DECISIONS.md.
 *   - Core ticker also gained fetchDisplacement() (UNHCR Refugee Data
 *     Finder API, fully keyless, no new secret), a Pillar 3 indicator:
 *     global forcibly displaced persons (refugees + asylum-seekers + IDPs
 *     + other people in need of international protection), annual. Takes
 *     the ristra token already reserved for Pillar 3. Peace module
 *     (separate output, peace-data.json): fetchDisplacementByRegion(),
 *     same API, breaking the same population down by UNHCR region of
 *     origin for the panel's grouped bar chart \u2014 the dashboard's first
 *     non-time-series panel chart. Both unverified against a live
 *     response (no network egress in this sandbox); see DECISIONS.md.
 *   - Discourse-tagging module (separate output, discourse-data.json, not
 *     the ticker): fetchDiscourseTags(), sourced from the GovInfo
 *     Congressional Record (CREC) API \u2014 official daily speech transcripts,
 *     fitting the already-logged "public speech transcripts... not private
 *     citizens' social media" input scope. Scored with a lexicon-based
 *     method (Moral Foundations Dictionary + an NRC-style emotion lexicon)
 *     rather than an LLM call \u2014 chosen by request over both a paid
 *     Anthropic API call and a locally-run open model, on interpretability,
 *     setup-lift, and methodological-credibility grounds. This is
 *     deliberately second-generation NLP by the Törnberg paper's own
 *     typology (dictionary/word-frequency matching), not the third-
 *     generation "TDAA" framing floated earlier in this project's design
 *     discussion \u2014 see DECISIONS.md, "Discourse-tagging module", for the
 *     full reasoning and the tradeoff this accepts. The bundled word lists
 *     are a small illustrative STARTER SUBSET, not the full published MFD
 *     2.0 / NRC EmoLex files \u2014 swap in the full dictionaries (both free
 *     for academic use) before treating this as a real research instrument.
 *   - Defined but NOT in the active `fetchers` pipeline: fetchGini and
 *     fetchIncomeGap (Census ACS). Both only ever produce change: "n/a" —
 *     a single-point annual read with no prior-year diff — so neither
 *     carries a data-driven indication of movement, which was the bar set
 *     for the core indicator set. Kept in the file, not deleted, in case a
 *     future pass adds the second-year fetch + diff needed to qualify.
 *   - If a fetch fails, we keep whatever value was already in ticker-data.json
 *     for that indicator rather than crashing the whole run or writing a blank.
 */

import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const OUT_PATH = path.resolve(process.cwd(), "ticker-data.json");
const ENERGY_OUT_PATH = path.resolve(process.cwd(), "energy-data.json");
const GINI_OUT_PATH = path.resolve(process.cwd(), "gini-data.json");
const STUDENT_LOAN_OUT_PATH = path.resolve(process.cwd(), "student-loan-data.json");
const PEACE_OUT_PATH = path.resolve(process.cwd(), "peace-data.json");
const DISCOURSE_OUT_PATH = path.resolve(process.cwd(), "discourse-data.json");
const DEMOCRACY_OUT_PATH = path.resolve(process.cwd(), "democracy-data.json");
const LEGAL_OUT_PATH = path.resolve(process.cwd(), "legal-data.json");

const fmtPP = (n, digits = 1) => `${n.toFixed(digits)}pp`;
const fmtSigned = (n, digits = 1, suffix = "pp") =>
  `${n >= 0 ? "+" : ""}${n.toFixed(digits)}${suffix}`;

async function loadExisting() {
  try {
    const raw = await readFile(OUT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const byId = {};
    for (const ind of parsed.indicators ?? []) byId[ind.id] = ind;
    return byId;
  } catch {
    return {};
  }
}

async function loadExistingEnergy() {
  try {
    const raw = await readFile(ENERGY_OUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadExistingGini() {
  try {
    const raw = await readFile(GINI_OUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadExistingStudentLoan() {
  try {
    const raw = await readFile(STUDENT_LOAN_OUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadExistingPeace() {
  try {
    const raw = await readFile(PEACE_OUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadExistingDiscourse() {
  try {
    const raw = await readFile(DISCOURSE_OUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadExistingDemocracy() {
  try {
    const raw = await readFile(DEMOCRACY_OUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadExistingLegal() {
  try {
    const raw = await readFile(LEGAL_OUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function safeFetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// GDELT's public API has no uptime SLA and is occasionally slow or
// unreachable from CI runners (network-level "fetch failed", not an HTTP
// error). Retry a couple of times with a short timeout before giving up and
// letting main() fall back to the previous value.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// SEC's own developer documentation asks requesters to identify
// themselves honestly (app name + contact email), not with a browser
// string, and to moderate request volume \u2014 see DECISIONS.md, "Legal
// case-narrative tagging module," for why this is deliberately NOT
// BROWSER_UA. PLACEHOLDER: replace the contact email below with a real
// one before running this against SEC's servers unattended.
const SEC_UA = "Zauberberg-Dashboard/1.0 (contact: REPLACE_WITH_REAL_CONTACT_EMAIL@example.com)";

async function safeFetchText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// ---- FRED: 10Y-2Y Treasury Yield Spread (T10Y2Y) ----
async function fetchFred() {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY not set");
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=T10Y2Y&api_key=${key}&file_type=json&sort_order=desc&limit=2`;
  const data = await safeFetchJson(url);
  const obs = (data.observations ?? []).filter((o) => o.value !== ".");
  if (obs.length < 1) throw new Error("FRED: no usable observations");
  const latest = parseFloat(obs[0].value);
  const prev = obs.length > 1 ? parseFloat(obs[1].value) : latest;
  return {
    id: "treasury-spread",
    name: "10Y\u20132Y Treasury Yield Spread (FRED: T10Y2Y)",
    value: fmtPP(latest),
    change: fmtSigned(latest - prev),
    series: "terracotta",
    cadence: "daily",
    asOf: obs[0].date,
  };
}

// ---- FRED: Labor Share of Income (Penn World Table via FRED) ----
// Deliberately using LABSHPUSA156NRUG (units: Ratio, i.e. unambiguously a
// share of GDP) rather than BLS's quarterly index series (PRS84006173),
// whose units are an index base rather than a clean percentage — annual
// cadence here, consistent with the other annual indicators already on
// the ticker (WID wealth/income share, Census Gini).
async function fetchLaborShare() {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY not set");
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=LABSHPUSA156NRUG&api_key=${key}&file_type=json&sort_order=desc&limit=2`;
  const data = await safeFetchJson(url);
  const obs = (data.observations ?? []).filter((o) => o.value !== ".");
  if (obs.length < 1) throw new Error("FRED: no usable labor-share observations");
  const latest = parseFloat(obs[0].value) * 100;
  const prev = obs.length > 1 ? parseFloat(obs[1].value) * 100 : latest;
  return {
    id: "labor-share",
    name: "Labor Share of GDP (Penn World Table via FRED, annual)",
    value: `${latest.toFixed(1)}%`,
    change: fmtSigned(latest - prev, 1, "pp"),
    series: "terracotta",
    cadence: "annual",
    // Value-polarity exception (added 2026-09-11, by request): rising labor
    // share is read as good in this project's own distributive-justice
    // framing (Piketty/Milanovic), so its delta overrides the neutral
    // Pillar-1 terracotta with turquoise(up)/ochre(down) \u2014 see the CSS
    // comment above .ticker__delta for the tradeoff this creates.
    polarity: "good-up",
    asOf: obs[0].date,
    // Verified 2026-09-11 directly against
    // https://fred.stlouisfed.org/series/LABSHPUSA156NRUG: latest real
    // observation is 2023 (56.83%), and FRED lists this series' "Next
    // Release Date" as Not Available. Penn World Table 11.0 may not get
    // a scheduled future update at all \u2014 a bigger staleness risk than
    // ordinary annual cadence. If this fetch keeps returning 2023 well
    // into the future, that's the source being stuck, not a fetch bug.
    note: "Annual release \u2014 value is static between updates. Source has no scheduled next release as of 2026-09-11.",
  };
}

// ---- FRED: Nominal Broad U.S. Dollar Index (currency hegemony proxy) ----
// Trade-weighted dollar index, daily, index Jan 2006=100. Reuses
// FRED_API_KEY \u2014 no new secret needed. Pillar 1 fit: Strange's
// structural power over money/finance; also the same dollar-clearing
// infrastructure Farrell & Newman's "weaponized interdependence" concerns.
async function fetchDollarIndex() {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY not set");
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DTWEXBGS&api_key=${key}&file_type=json&sort_order=desc&limit=2`;
  const data = await safeFetchJson(url);
  const obs = (data.observations ?? []).filter((o) => o.value !== ".");
  if (obs.length < 1) throw new Error("FRED: no usable DTWEXBGS observations");
  const latest = parseFloat(obs[0].value);
  const prev = obs.length > 1 ? parseFloat(obs[1].value) : latest;
  return {
    id: "dollar-index",
    name: "Nominal Broad U.S. Dollar Index (FRED: DTWEXBGS)",
    value: latest.toFixed(2),
    change: fmtSigned(latest - prev, 2, ""),
    series: "terracotta",
    cadence: "daily",
    asOf: obs[0].date,
  };
}


async function fetchBls() {
  const key = process.env.BLS_API_KEY; // optional
  const seriesid = ["LNS14000006", "LNS14000003"]; // Black, White (seas. adj.)
  const thisYear = new Date().getFullYear();
  const body = {
    seriesid,
    startyear: String(thisYear - 1),
    endyear: String(thisYear),
    ...(key ? { registrationkey: key } : {}),
  };
  const res = await fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BLS HTTP ${res.status}`);
  const data = await res.json();
  const series = {};
  for (const s of data.Results?.series ?? []) {
    series[s.seriesID] = s.data
      .filter((d) => d.value !== undefined)
      .sort((a, b) => `${b.year}${b.period}`.localeCompare(`${a.year}${a.period}`));
  }
  const black = series["LNS14000006"];
  const white = series["LNS14000003"];
  if (!black?.length || !white?.length) throw new Error("BLS: missing series data");
  const gapAt = (i) => parseFloat(black[i].value) - parseFloat(white[i].value);
  const latestGap = gapAt(0);
  const prevGap = black.length > 1 && white.length > 1 ? gapAt(1) : latestGap;
  return {
    id: "unemployment-gap",
    name: "Black\u2013White Unemployment Rate Gap (BLS, monthly)",
    value: fmtPP(latestGap),
    change: fmtSigned(latestGap - prevGap),
    // sage, not ristra: ristra is reserved for links + Pillar-3 going
    // forward, and every other Pillar-2 (distributional justice) indicator
    // now uses sage \u2014 see Visual Encoding Registry in the data dictionary.
    series: "sage",
    cadence: "monthly",
    asOf: `${black[0].year}-${black[0].period.replace("M", "")}`,
  };
}

// ---- OWID (WID.world-sourced): Global Top 1% Wealth Share ----
// Minimal CSV line parser (handles quoted fields) — OWID's CSVs are simple,
// but this avoids silently misaligning columns if a field is ever quoted.
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

async function fetchOwidPercentIndicator({ url, entityName, preferValueHeaderRegex }) {
  const csv = await safeFetchText(url, { headers: { "User-Agent": BROWSER_UA } });
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const entityIdx = header.indexOf("Entity");
  const yearIdx = header.indexOf("Year");
  const codeIdx = header.indexOf("Code");
  const candidateIdxs = header
    .map((_, idx) => idx)
    .filter((idx) => idx !== entityIdx && idx !== yearIdx && idx !== codeIdx);
  if (entityIdx === -1 || yearIdx === -1 || candidateIdxs.length < 1) {
    throw new Error(`OWID: unexpected columns: ${header.join(" | ")}`);
  }
  const valueIdx = preferValueHeaderRegex
    ? candidateIdxs.find((idx) => preferValueHeaderRegex.test(header[idx])) ?? candidateIdxs[0]
    : candidateIdxs[0];

  const rows = lines
    .slice(1)
    .map(parseCsvLine)
    .filter((cols) => cols[entityIdx] === entityName && cols[valueIdx] !== "" && !Number.isNaN(parseFloat(cols[valueIdx])))
    .sort((a, b) => Number(b[yearIdx]) - Number(a[yearIdx]));
  if (rows.length < 1) throw new Error(`OWID: no usable "${entityName}" rows found`);
  const latest = rows[0];
  const prev = rows[1] ?? latest;
  // NOTE: OWID's CSV export already stores these as percent (their own
  // metadata says "Unit: %"), NOT as a 0-1 fraction like WID.world's raw
  // source data. Do not multiply by 100 here — that was the bug that
  // produced 1900%+ readings.
  return {
    latestPct: parseFloat(latest[valueIdx]),
    prevPct: parseFloat(prev[valueIdx]),
    year: latest[yearIdx],
  };
}

async function fetchWealthShare() {
  const url =
    "https://ourworldindata.org/grapher/wealth-share-richest.csv?v=1&csvType=full&useColumnShortNames=false&quantile=richest_1pct";
  const { latestPct, prevPct, year } = await fetchOwidPercentIndicator({
    url,
    entityName: "World",
    preferValueHeaderRegex: /1\s*%|richest_1pct/i,
  });
  return {
    id: "wealth-share-top1",
    name: "Global Top 1% Wealth Share (WID.world, via OWID)",
    value: `${latestPct.toFixed(1)}%`,
    change: fmtSigned(latestPct - prevPct, 1, "pp"),
    series: "sage",
    cadence: "annual",
    // Value-polarity exception (added 2026-09-11, by request): rising top-1%
    // concentration is read as bad, so its delta overrides the neutral
    // Pillar-2 sage with ochre(up)/turquoise(down) instead \u2014 universal
    // good=turquoise/bad=ochre scheme, added same day, replacing an
    // earlier sage/ristra version. Note ochre is also spr-level's plain
    // Pillar-4 identity color \u2014 known, accepted collision, see the CSS
    // comment above .ticker__delta.
    polarity: "bad-up",
    asOf: year,
    note: "Annual release \u2014 value is static between WID.world's yearly updates.",
  };
}

// ---- OWID (WID.world-sourced): US Top 1% Income Share (before tax) ----
async function fetchIncomeShareUS() {
  const url =
    "https://ourworldindata.org/grapher/income-share-top-1-before-tax-wid.csv?v=1&csvType=full&useColumnShortNames=false";
  const { latestPct, prevPct, year } = await fetchOwidPercentIndicator({
    url,
    entityName: "United States",
  });
  return {
    id: "income-share-top1-us",
    name: "US Top 1% Income Share, Before Tax (WID.world, via OWID)",
    value: `${latestPct.toFixed(1)}%`,
    change: fmtSigned(latestPct - prevPct, 1, "pp"),
    // sage, not turquoise: consolidating every Pillar-2 indicator onto one
    // token frees turquoise for Pillar 3 once OFAC ships \u2014 see the
    // Visual Encoding Registry in the data dictionary.
    series: "sage",
    cadence: "annual",
    // Value-polarity exception (added 2026-09-11, by request): same
    // reasoning as wealth-share-top1 \u2014 rising top-1% concentration
    // reads as bad, so the delta overrides sage with ochre(up)/turquoise(down).
    polarity: "bad-up",
    asOf: year,
    note: "Annual release \u2014 value is static between WID.world's yearly updates.",
  };
}

// ---- OWID (V-Dem-sourced): US Liberal Democracy Index, full annual time series ----
// Powers the Democracy (Pillar 1) panel's line chart — see index.html and
// DECISIONS.md, "Democracy module." Pillar 1 fit, per the 2026-09-13
// extension of that pillar's test (Strange; Mudde; Norris & Inglehart;
// Levitsky & Ziblatt, added specifically for this): erosion of executive
// constraints, clean elections, and civil-society/media freedom is itself
// a leverage-over-structures signal, the same "who holds leverage" test
// already used for treasury-spread/labor-share/dollar-index and the
// dormant student-loan panel — this is a second, distinct Pillar-1 panel
// candidate, not a replacement for that one (see DECISIONS.md).
//
// Source: V-Dem's Liberal Democracy Index (LDI, 0\u20131 scale), via OWID's
// hosted CSV mirror, reusing the parseCsvLine() helper already written
// for wealth-share-top1/income-share-top1-us — but NOT reusing
// fetchOwidPercentIndicator() itself, since that helper assumes the
// value column is stored as "%" in OWID's export; LDI is a plain 0\u20131
// index, not a percent.
//
// CAVEAT (same pattern as fetchGiniSeries/fetchSPR/fetchGenerationMix):
// written without a live test call (no network egress in this sandbox)
// \u2014 the grapher CSV slug ("liberal-democracy-index") and column layout
// are inferred from OWID's Democracy data explorer, not confirmed against
// a real response. Verify the first real Action run's header row before
// trusting this unattended.
async function fetchDemocracySeries() {
  const url =
    "https://ourworldindata.org/grapher/liberal-democracy-index.csv?v=1&csvType=full&useColumnShortNames=false";
  const csv = await safeFetchText(url, { headers: { "User-Agent": BROWSER_UA } });
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const entityIdx = header.indexOf("Entity");
  const yearIdx = header.indexOf("Year");
  const codeIdx = header.indexOf("Code");
  const valueIdx = header
    .map((_, idx) => idx)
    .find((idx) => idx !== entityIdx && idx !== yearIdx && idx !== codeIdx);
  if (entityIdx === -1 || yearIdx === -1 || valueIdx === undefined) {
    throw new Error(`OWID: unexpected liberal-democracy-index columns: ${header.join(" | ")}`);
  }

  const rows = lines
    .slice(1)
    .map(parseCsvLine)
    .filter(
      (cols) =>
        cols[entityIdx] === "United States" &&
        cols[valueIdx] !== "" &&
        !Number.isNaN(parseFloat(cols[valueIdx]))
    )
    .map((cols) => ({ year: Number(cols[yearIdx]), value: parseFloat(cols[valueIdx]) }))
    .sort((a, b) => a.year - b.year);

  if (rows.length < 2) throw new Error("OWID: not enough usable United States liberal-democracy-index rows");

  const latest = rows[rows.length - 1];
  const prev = rows[rows.length - 2];

  // PLAUSIBILITY GUARD, same convention as fetchDisplacement(): LDI is
  // bounded [0, 1] by construction. A parsed value outside a generous
  // [0, 1] band is a stronger signal of a column-mapping bug (e.g. picking
  // up a code/margin-of-error column instead of the index itself) than of
  // reality.
  if (latest.value < 0 || latest.value > 1) {
    throw new Error(`OWID: parsed liberal-democracy-index value (${latest.value}) outside the valid [0, 1] range \u2014 likely a column mismatch`);
  }

  return {
    asOf: String(latest.year),
    latestValue: latest.value,
    change: fmtSigned(latest.value - prev.value, 3, ""),
    series: rows,
  };
}

// ---- FRED: US Home Price Index, YoY growth (asset-wealth inequality framing) ----
// Pillar 2 fit, added 2026-09-11 by request: the ticker VALUE is the
// year-over-year appreciation rate, not the raw index level (an index
// level on a Jan-2000=100 base is meaningless without context, and a bare
// price series would read as supply-and-demand economics anyway \u2014 the
// same relevance problem DECISIONS.md already flagged and resolved for
// energy-price-volatility). Framed per Piketty's capital-appreciation
// logic applied to housing: home-price gains accrue to existing owners as
// asset wealth while pricing out renters/non-owners, so faster
// appreciation reads as a faster-widening asset-wealth gap \u2014 which is
// why "change" here is the MONTH-OVER-MONTH SHIFT IN THE YOY RATE
// (acceleration/deceleration of that gap), not a simple level diff.
//
// Deliberately NOT given a `polarity` field, unlike wealth-share-top1 /
// income-share-top1-us: those measure concentration at the top directly,
// so "up = bad" is unambiguous. A national home-price index instead
// reflects a broad (~65%) homeowner population's asset gains, with mixed
// effects (existing owners gain, renters/prospective buyers lose) that
// don't reduce to a single normative direction the way top-1%-share does.
// Per DECISIONS.md's own stated bar ("equally clear, stated normative
// grounding"), that's not met here, so this stays series-token-colored
// like the majority of this project's other indicators.
//
// CAVEAT (same pattern as fetchSPR/fetchEnergyVolatility): written
// without a live test call (no network egress in this sandbox) \u2014 the
// FRED observations JSON shape matches every other verified FRED fetcher
// in this file, so that risk is low, but confirm CSUSHPISA is still the
// right series id (S&P/Case-Shiller U.S. National Home Price Index,
// seasonally adjusted, monthly) on the first real run \u2014 FRED has a
// separate NSA variant (CSUSHPINSA) that would reintroduce seasonal
// noise into the YoY figure if swapped in by mistake.
async function fetchHousingPriceIndex() {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY not set");
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=CSUSHPISA&api_key=${key}&file_type=json&sort_order=desc&limit=14`;
  const data = await safeFetchJson(url);
  const obs = (data.observations ?? [])
    .filter((o) => o.value !== ".")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }));
  if (obs.length < 14) throw new Error("FRED: not enough usable CSUSHPISA observations for two YoY points");

  const yoy = (i) => (obs[i].value / obs[i + 12].value - 1) * 100;
  const latestYoy = yoy(0);
  const prevYoy = yoy(1);

  return {
    id: "housing-price-index",
    name: "US Home Price YoY Growth (S&P/Case-Shiller via FRED: CSUSHPISA)",
    value: `${latestYoy >= 0 ? "+" : ""}${latestYoy.toFixed(1)}%`,
    change: fmtSigned(latestYoy - prevYoy, 1, "pp"),
    series: "sage",
    cadence: "monthly",
    asOf: obs[0].date,
    note: "Value is year-over-year home-price appreciation; change is the month-over-month shift in that YoY rate (i.e. whether asset-wealth gains are accelerating or decelerating), not a simple index-point diff.",
  };
}


// ---- EIA: Strategic Petroleum Reserve, weekly crude oil ending stocks ----
// Pillar 4 fit: an SPR level is a held strategic energy buffer/leverage,
// i.e. energy security as state power (Mitchell, Carbon Democracy) — not
// a bare commodity price, which DECISIONS.md's Pillar 4 test excludes.
// Series PET.WCSSTUS1.W is published in thousand barrels; converted to
// million barrels below to match how SPR levels are conventionally
// reported. NOTE: this fetcher was written without being able to make a
// live test call (sandboxed, no network egress here) — the `/seriesid/`
// shortcut and its JSON shape (response.data[].period / .value) are
// per EIA's documented APIv2 emulation of legacy v1 series IDs, but
// verify the very first real run's output shape before trusting it
// unattended; adjust the `rows[i].value` / `.period` accessors below if
// the actual response nests differently.
async function fetchSPR() {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error("EIA_API_KEY not set");
  const url = `https://api.eia.gov/v2/seriesid/PET.WCSSTUS1.W?api_key=${key}&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=2`;
  const data = await safeFetchJson(url);
  const rows = data?.response?.data ?? [];
  if (rows.length < 1) throw new Error("EIA: no usable SPR observations");
  const latestRaw = parseFloat(rows[0].value);
  const prevRaw = rows.length > 1 ? parseFloat(rows[1].value) : latestRaw;
  const latest = latestRaw / 1000; // thousand bbl -> million bbl
  const prev = prevRaw / 1000;
  return {
    id: "spr-level",
    name: "Strategic Petroleum Reserve \u2014 Crude Oil Stocks (EIA, weekly)",
    value: `${latest.toFixed(1)} MMbbl`,
    change: fmtSigned(latest - prev, 1, " MMbbl"),
    series: "ochre",
    cadence: "weekly",
    asOf: String(rows[0].period),
  };
}


// ---- FRED: US Household Income Gini Ratio, full annual time series ----
// Powers the Distributional Justice (Pillar 2) panel's line chart — see
// index.html and DECISIONS.md, "Distributional Justice module
// visualization." NOT the same thing as fetchGini() further below: that
// function pulls a single-point annual read from Census ACS for a
// prospective *ticker* value and is deliberately not wired into the
// active fetchers pipeline (see its own comment for why). This fetcher
// instead pulls the full history of GINIALLRH (Census-sourced, delivered
// via FRED) to drive a genuine multi-year line, and reuses FRED_API_KEY —
// no new secret, same reasoning as fetchDollarIndex/fetchLaborShare.
// Chosen over FRED's SIPOVGINIUSA (World Bank series) because GINIALLRH
// is fresher (through 2024, last updated 2025-09-09 per FRED's page as
// checked 2026-09-11) and keeps this indicator's provenance consistent
// with the Census-sourced framing used elsewhere on this dashboard.
// CAVEAT (same pattern as fetchSPR/fetchGenerationMix): written without a
// live test call in this sandbox (no network egress) — the FRED
// observations JSON shape (observations[].date / .value) matches every
// other FRED fetcher already verified in this file (fetchFred,
// fetchLaborShare, fetchDollarIndex), so the shape risk here is low, but
// verify the first real Action run regardless.
async function fetchGiniSeries() {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY not set");
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=GINIALLRH&api_key=${key}&file_type=json&sort_order=asc&observation_start=1990-01-01`;
  const data = await safeFetchJson(url);
  const obs = (data.observations ?? []).filter((o) => o.value !== ".");
  if (obs.length < 2) throw new Error("FRED: not enough usable GINIALLRH observations");
  const series = obs.map((o) => ({
    year: Number(o.date.slice(0, 4)),
    value: parseFloat(o.value),
  }));
  const latest = series[series.length - 1];
  const prev = series[series.length - 2];
  return {
    asOf: String(latest.year),
    latestValue: latest.value,
    change: fmtSigned(latest.value - prev.value, 3, ""),
    series,
  };
}

// ---- FRED: Student Loans Owned and Securitized (structural-power/leverage framing) ----
// Powers the Structural Power & Political Economy (Pillar 1) panel's line
// chart — see index.html and DECISIONS.md, "Structural Power module
// visualizations." Pillar 1 fit (Strange; Harvey): the balance itself \u2014
// debt that has been packaged and is HELD by financial institutions \u2014
// is the leverage signal, the same way the SPR ticker indicator's bare
// reserve level (not a derived rate) was accepted as the Pillar 4 leverage
// signal. No YoY/ratio transformation needed here for the same reason.
// Reuses FRED_API_KEY \u2014 no new secret.
//
// SLOASM (Board of Governors G.19, monthly, millions of USD, NSA) only
// actually reports on a quarterly cadence within its monthly slots (Mar/
// Jun/Sep/Dec populated, other months come back as "."), confirmed via a
// live fetch of https://fred.stlouisfed.org/data/SLOASM on 2026-09-11 \u2014
// this fetcher filters those empty months out rather than treating them
// as a bug. Values converted from millions to trillions of USD for
// display (matches the SPR indicator's unit-conversion convention).
//
// CAVEAT: unlike fetchSPR/fetchGenerationMix/fetchGiniSeries, this
// specific FRED series_id + JSON shape (observations[].date/.value) WAS
// confirmed live on 2026-09-11 (both the series page and the full data
// table), so this fetcher carries less shape-risk than those \u2014 no
// "verify against a live response" caveat needed here.
async function fetchStudentLoanSeries() {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY not set");
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=SLOASM&api_key=${key}&file_type=json&sort_order=asc&observation_start=2006-01-01`;
  const data = await safeFetchJson(url);
  const obs = (data.observations ?? []).filter((o) => o.value !== ".");
  if (obs.length < 2) throw new Error("FRED: not enough usable SLOASM observations");
  const series = obs.map((o) => ({
    date: o.date,
    trillions: Math.round((parseFloat(o.value) / 1_000_000) * 1000) / 1000, // millions -> trillions, 3dp
  }));
  const latest = series[series.length - 1];
  const prev = series[series.length - 2];
  return {
    asOf: latest.date,
    latestValue: latest.trillions,
    change: fmtSigned(latest.trillions - prev.trillions, 3, "T"),
    series,
  };
}

// ---- EIA: U.S. electricity generation mix, bucketed fossil/nuclear/renewables ----
// Powers the Energy module's generation-mix stacked area chart (see
// index.html, DECISIONS.md "Energy module visualizations"). Pillar 4 fit:
// framed as transition politics (Malm; Riofrancos; Mitchell), not a bare
// supply/demand mix — same reasoning as the SPR ticker indicator.
//
// CAVEAT (same pattern as fetchSPR below): written without a live test call
// (sandboxed, no network egress here). The fueltypeid codes below and the
// "all sectors combined" sectorid ("99") are per EIA's documented APIv2
// browser for electric-power-operational-data as of this writing, but were
// NOT confirmed against a real response. Verify the first real Action run's
// row shape (row.period / row.fueltypeid / row.generation) before trusting
// this unattended — these facet values are the most likely thing to need
// correcting, not the overall approach.
async function fetchGenerationMix() {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error("EIA_API_KEY not set");

  const FUEL_BUCKETS = {
    fossil: ["COW", "PEL", "NG"], // coal, petroleum liquids, natural gas
    nuclear: ["NUC"],
    renewables: ["WND", "SUN", "DPV", "WAT", "GEO", "WWW"], // wind, utility solar, small-scale solar, hydro, geothermal, wood/waste
  };
  const allCodes = Object.values(FUEL_BUCKETS).flat();
  const codeToBucket = {};
  for (const [bucket, codes] of Object.entries(FUEL_BUCKETS)) {
    for (const code of codes) codeToBucket[code] = bucket;
  }

  const params = new URLSearchParams({
    api_key: key,
    frequency: "annual",
    "data[0]": "generation",
    "facets[location][]": "US",
    "facets[sectorid][]": "99",
    "sort[0][column]": "period",
    "sort[0][direction]": "desc",
    offset: "0",
    length: String(allCodes.length * 8), // ~8 years' worth per fuel type, generously
  });
  for (const code of allCodes) params.append("facets[fueltypeid][]", code);

  const url = `https://api.eia.gov/v2/electricity/electric-power-operational-data/data/?${params.toString()}`;
  const data = await safeFetchJson(url);
  const rows = data?.response?.data ?? [];
  if (!rows.length) throw new Error("EIA: no generation-mix rows returned");

  const byPeriod = {};
  for (const row of rows) {
    const bucket = codeToBucket[row.fueltypeid];
    const val = parseFloat(row.generation);
    if (!bucket || Number.isNaN(val)) continue;
    byPeriod[row.period] ??= { fossil: 0, nuclear: 0, renewables: 0 };
    byPeriod[row.period][bucket] += val;
  }

  const periods = Object.keys(byPeriod).sort((a, b) => b.localeCompare(a));
  if (!periods.length) throw new Error("EIA: could not bucket any generation-mix rows");

  // Drop the most recent period if it looks partial (well under the
  // second-most-recent year's total) so a part-year doesn't render as a
  // misleadingly low/high share.
  const completePeriods = periods.filter((p, i) => {
    if (i === 0 && periods.length > 1) {
      const totalHere = Object.values(byPeriod[p]).reduce((s, v) => s + v, 0);
      const totalPrev = Object.values(byPeriod[periods[1]]).reduce((s, v) => s + v, 0);
      return totalHere >= totalPrev * 0.9;
    }
    return true;
  });

  const series = completePeriods
    .slice(0, 6)
    .sort((a, b) => a.localeCompare(b))
    .map((period) => {
      const { fossil, nuclear, renewables } = byPeriod[period];
      const total = fossil + nuclear + renewables;
      return {
        year: Number(period),
        fossil: Math.round((fossil / total) * 1000) / 10,
        nuclear: Math.round((nuclear / total) * 1000) / 10,
        renewables: Math.round((renewables / total) * 1000) / 10,
      };
    });

  return { asOf: completePeriods[0], series };
}

// ---- FRED: Energy price volatility (WTI crude, 20-trading-day realized vol) ----
// Pillar 4 leverage framing, added 2026-09-11 by request: the SIGNAL here
// is the *swing*, not the price level. A bare WTI spot price would fail
// the Pillar 4 relevance test the same way DECISIONS.md already excludes
// it for the SPR indicator ("not a bare commodity price"). Realized
// volatility \u2014 how sharply the price is moving \u2014 is instead read as
// exposure to supply-chain disruption and geopolitical leverage over
// energy infrastructure (Klein; Riofrancos; Malm; Mitchell): a calm
// market and a market being whipsawed by an embargo, a pipeline attack,
// or an OPEC+ cut convey very different things about who holds leverage,
// even when the price is not stated at all.
//
// Method: pull the most recent ~45 daily WTI closes (DCOILWTICO, which is
// NOT every calendar day \u2014 it skips weekends/holidays, so we over-fetch
// and then take the first 21 usable closes to get 20 daily returns), take
// day-over-day log returns, and report the annualized stdev (stdev * sqrt(252))
// as a percent. "change" compares that to the same calculation run one day
// earlier (i.e. the trailing 20-return window shifted back by one
// observation), so the ticker still shows a meaningful day-over-day delta
// for a rolling-window statistic rather than a fabricated one.
//
// CAVEAT (same pattern as fetchSPR/fetchGenerationMix): written without a
// live test call (no network egress in this sandbox) \u2014 the FRED
// observations JSON shape matches every other FRED fetcher already
// verified in this file, so that risk is low, but the volatility math
// itself (window size, log-return convention, annualization factor) has
// not been sanity-checked against a real print. Verify the first real
// Action run's value against an independent WTI-vol source before
// trusting it unattended.
async function fetchEnergyVolatility() {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY not set");
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DCOILWTICO&api_key=${key}&file_type=json&sort_order=desc&limit=45`;
  const data = await safeFetchJson(url);
  const obs = (data.observations ?? [])
    .filter((o) => o.value !== ".")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .sort((a, b) => b.date.localeCompare(a.date)); // newest first

  if (obs.length < 22) throw new Error("FRED: not enough usable DCOILWTICO observations for a 20-return window");

  const logReturn = (newer, older) => Math.log(newer.value / older.value);

  const stdevAnnualized = (window) => {
    // window: newest-first array of closes; produces window.length - 1 returns
    const returns = [];
    for (let i = 0; i < window.length - 1; i++) returns.push(logReturn(window[i], window[i + 1]));
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(252) * 100; // annualized, as a percent
  };

  const latestVol = stdevAnnualized(obs.slice(0, 21));   // most recent 20 returns
  const prevVol = stdevAnnualized(obs.slice(1, 22));     // window shifted back one observation

  return {
    id: "energy-price-volatility",
    name: "Energy Price Volatility \u2014 WTI 20-Day Realized Vol (FRED: DCOILWTICO)",
    value: `${latestVol.toFixed(1)}%`,
    change: fmtSigned(latestVol - prevVol, 1, "pp"),
    series: "ochre",
    cadence: "daily",
    asOf: obs[0].date,
    note: "Annualized realized volatility of WTI crude over the trailing 20 trading days \u2014 the swing, not the price level, is the Pillar 4 signal (supply-shock/geopolitical exposure).",
  };
}


// ---- UNHCR: Forcibly Displaced Persons, Global Total (Pillar 3) ----
// Added 2026-09-11 by request. Sum of refugees, asylum-seekers, IDPs, and
// other people in need of international protection (UNHCR's own "forcibly
// displaced" headline definition) \u2014 deliberately excludes the
// stand-alone stateless-persons column, since UNHCR's own methodology
// notes most stateless people were never displaced. Read per Galtung/
// Fanon as the human toll of direct/structural violence and dominant-
// power blowback, not a bare migration count \u2014 see DECISIONS.md,
// Technical Requirements.
//
// UNHCR's Refugee Data Finder API (base https://api.unhcr.org/population/v1/)
// is fully keyless \u2014 no registration, no new secret \u2014 chosen over
// ACLED (already dropped from v1) and UCDP's GED API (free but needs its
// own token) for that reason. Omitting both coo and coa params aggregates
// every country pair into a single global row per the API's documented
// behavior ("if not specified, data for this dimension will be summed and
// aggregated to one row").
//
// Deliberately NO `polarity` field for now \u2014 see the DECISIONS.md entry
// for why this is flagged as a candidate rather than decided here.
//
// UPDATE (2026-09-11): the first real Action run confirmed the field
// names were fine all along (refugees/asylum_seekers/idps/oip, r.year) \u2014
// the actual bug was coo_all=false&coa_all=false not aggregating
// server-side as docs implied, combined with UNHCR's default 100-row page
// cap silently truncating the result. See the fix comment inside the
// function body and DECISIONS.md for the full root-cause writeup.
async function fetchDisplacement() {
  // ROOT CAUSE, REVISED (2026-09-12, after a live run returned a 15.0M
  // global total against a real ~120M+): the 2026-09-11 "fix" below was
  // itself based on a misreading of UNHCR's own docs. Per the API
  // reference, coo/coa "if not specified, data for this dimension will be
  // summed and aggregated to one row" \u2014 aggregation happens when the
  // dimension is OMITTED, not when coo_all=true is set. coo_all=true does
  // the opposite: it explicitly breaks out every origin country as its
  // own row rather than aggregating them away. So the previous request
  // (coo_all=true&coa_all=false) was fetching ordinary per-(origin,
  // destination)-country-pair rows \u2014 there are far more than 1000 of
  // those across a 3-year window \u2014 and summing only the first 1000 of
  // them undercounted by roughly 8x. Fixed by dropping coo/coo_all/coa/
  // coa_all entirely, so both dimensions aggregate server-side into a
  // single row per year, which is what this ticker indicator actually
  // wants. (fetchDisplacementByRegion() below legitimately needs the
  // per-origin breakdown and keeps coo_all=true, but now correctly omits
  // coa/coa_all so destinations aggregate away instead of also being
  // broken out \u2014 see that function's own comment.)
  const thisYear = new Date().getFullYear();
  const url = `https://api.unhcr.org/population/v1/population/?yearFrom=${thisYear - 2}&yearTo=${thisYear}&columns[]=refugees&columns[]=asylum_seekers&columns[]=idps&columns[]=oip`;
  const data = await safeFetchJson(url, { headers: { "User-Agent": BROWSER_UA } });
  const rows = (data?.items ?? data?.data ?? []).filter((r) => r.year);
  // DIAGNOSTIC: left in place to confirm the fix \u2014 with both dimensions
  // omitted, this should show one row per year (row count \u2248 3 for a
  // 3-year window), not the ~1000-row-capped shape from before.
  console.log("[diag] /population (global) sample row:", JSON.stringify(rows[0] ?? null));
  console.log("[diag] /population (global) row count:", rows.length);
  if (!rows.length) throw new Error("UNHCR: no usable population rows returned");

  const byYear = {};
  for (const r of rows) {
    const y = Number(r.year);
    const total =
      (Number(r.refugees) || 0) +
      (Number(r.asylum_seekers) || 0) +
      (Number(r.idps) || 0) +
      (Number(r.oip) || 0);
    byYear[y] = (byYear[y] ?? 0) + total;
  }
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  if (years.length < 1) throw new Error("UNHCR: could not aggregate any yearly totals");
  const latestYear = years[0];
  const prevYear = years[1] ?? latestYear;
  const latest = byYear[latestYear] / 1_000_000; // persons -> millions
  const prev = byYear[prevYear] / 1_000_000;

  // PLAUSIBILITY GUARD (added 2026-09-11, kept as defense-in-depth even
  // after the real fix above): UNHCR's own published global figure has
  // been in roughly the 100\u2013130M range for the past few years. A result
  // far outside a generous [50M, 300M] band is a stronger signal of a
  // parsing bug than of reality \u2014 fail loudly so main() falls back
  // rather than publish an implausible "live" number.
  if (latest < 50 || latest > 300) {
    throw new Error(
      `UNHCR: aggregated global total (${latest.toFixed(1)}M) is outside the plausible [50M, 300M] range \u2014 likely a field-name mismatch, see the [diag] log lines above`
    );
  }

  return {
    id: "forcibly-displaced",
    name: "Forcibly Displaced Persons \u2014 Global Total (UNHCR)",
    value: `${latest.toFixed(1)}M`,
    change: fmtSigned(latest - prev, 1, "M"),
    series: "ristra",
    cadence: "annual",
    asOf: String(latestYear),
    note: "Refugees + asylum-seekers + IDPs + other people in need of international protection, per UNHCR's own \u2018forcibly displaced\u2019 definition. Annual release \u2014 value is static between updates.",
  };
}

// ---- UNHCR: Forcibly displaced persons by region of origin (Pillar 3 panel chart) ----
// Powers the Peace and Conflict (Pillar 3) panel's grouped bar chart \u2014
// see index.html and DECISIONS.md, "Peace and Conflict module
// visualizations." This is the dashboard's first non-time-series panel
// chart: a cross-sectional snapshot of where displacement originates,
// latest year only, not a trend \u2014 requested in place of a line chart.
//
// Region bucketing is built at fetch time from the API's own /countries/
// endpoint (country -> UNHCR region), not a hardcoded country list, so
// the grouping doesn't silently go stale if regional classifications
// change. Uses coo_all=true to break out every origin country as its own
// row, while omitting coa/coa_all entirely so each origin country's row
// is already summed across every destination server-side \u2014 see the
// REVISED ROOT CAUSE comment inside the function for why coa_all=false
// (the previous approach) was wrong.
//
// UPDATE (2026-09-11): the first real Action run confirmed `c.region`
// (e.g. "Southern Asia") is the correct field on /countries/ \u2014 no
// field-name fix was needed there.
async function fetchDisplacementByRegion() {
  const countriesUrl = `https://api.unhcr.org/population/v1/countries/?limit=300`;
  const countriesData = await safeFetchJson(countriesUrl, { headers: { "User-Agent": BROWSER_UA } });
  const countryRows = countriesData?.items ?? countriesData?.data ?? [];
  // DIAGNOSTIC (added 2026-09-11 after the first real run returned only one
  // region \u2014 see DECISIONS.md): print the raw shape of the first
  // /countries row so the next Action log tells us the real field names
  // instead of us guessing again. Safe to leave in \u2014 it only writes to
  // the Action's own log, never to a committed JSON file.
  console.log("[diag] /countries sample row:", JSON.stringify(countryRows[0] ?? null));
  console.log("[diag] /countries row count:", countryRows.length);
  if (!countryRows.length) throw new Error("UNHCR: no usable /countries rows returned");
  const regionByCode = {};
  for (const c of countryRows) {
    const code = c.code ?? c.iso3 ?? c.id;
    const region = c.unhcr_region_name ?? c.unhcrRegionName ?? c.region ?? "Other/unknown";
    if (code) regionByCode[code] = region;
  }

  // REVISED ROOT CAUSE (2026-09-12, after fetchDisplacement()'s 15.0M
  // undercount exposed the same bug here): UNHCR's docs say a dimension
  // "if not specified... will be summed and aggregated to one row" \u2014
  // aggregation happens on OMISSION, not on passing coa_all=false. The
  // previous request (coo_all=true&coa_all=false) was actually returning
  // one row per (origin, destination) PAIR, not one row per origin
  // summed across destinations \u2014 this function's own client-side
  // byRegion summation happened to mostly paper over that (it sums
  // whatever rows come back, regardless of whether each row is a full
  // country total or one of several partial pair-rows for that country),
  // but it was still at risk of the exact same undercount if any single
  // origin country had more destination-pairs than fit under limit=1000
  // alongside every other country's pairs. Fixed by dropping coa/coa_all
  // entirely: each row is now already a full per-origin-country total,
  // summed across all destinations server-side, so client-side summation
  // here is now just "handle multiple rows if the API ever splits one
  // origin across pages" rather than load-bearing for correctness.
  const thisYear = new Date().getFullYear();
  const popUrl = `https://api.unhcr.org/population/v1/population/?year=${thisYear}&coo_all=true&limit=1000&columns[]=refugees&columns[]=asylum_seekers&columns[]=idps&columns[]=oip`;
  let data = await safeFetchJson(popUrl, { headers: { "User-Agent": BROWSER_UA } });
  let rows = data?.items ?? data?.data ?? [];
  // Fall back one year if the current year has no published rows yet
  // (annual release, so the latest full year is often the prior one).
  if (!rows.length) {
    const fallbackUrl = `https://api.unhcr.org/population/v1/population/?year=${thisYear - 1}&coo_all=true&limit=1000&columns[]=refugees&columns[]=asylum_seekers&columns[]=idps&columns[]=oip`;
    data = await safeFetchJson(fallbackUrl, { headers: { "User-Agent": BROWSER_UA } });
    rows = data?.items ?? data?.data ?? [];
  }
  // DIAGNOSTIC (same reason as above): print the raw shape of the first
  // /population row and the total row count actually returned.
  console.log("[diag] /population sample row:", JSON.stringify(rows[0] ?? null));
  console.log("[diag] /population row count:", rows.length);
  if (!rows.length) throw new Error("UNHCR: no usable by-origin population rows returned");

  const byRegion = {};
  let asOfYear = null;
  for (const r of rows) {
    asOfYear = r.year ?? asOfYear;
    const code = r.coo ?? r.coo_iso;
    const region = regionByCode[code] ?? "Other/unknown";
    const total =
      (Number(r.refugees) || 0) +
      (Number(r.asylum_seekers) || 0) +
      (Number(r.idps) || 0) +
      (Number(r.oip) || 0);
    byRegion[region] = (byRegion[region] ?? 0) + total;
  }

  const series = Object.entries(byRegion)
    .map(([region, total]) => ({ region, millions: Math.round((total / 1_000_000) * 100) / 100 }))
    .filter((d) => d.millions > 0)
    .sort((a, b) => b.millions - a.millions)
    .slice(0, 7); // top regions; keeps the bar chart readable

  if (!series.length) throw new Error("UNHCR: could not bucket any by-origin rows into regions");

  // SANITY CHECK (added 2026-09-11, after the first real run silently
  // published a one-region chart \u2014 see DECISIONS.md): a real global
  // breakdown should span at least a handful of regions. If parsing is
  // broken (wrong field names, most rows falling through to 0 or to a
  // single lookup hit), fewer than 3 nonzero regions is a stronger signal
  // of a shape mismatch than of reality, so treat it as a failure and let
  // main() fall back to the last published/placeholder data rather than
  // publish a misleadingly sparse chart labeled "live."
  if (series.length < 3) {
    throw new Error(
      `UNHCR: only ${series.length} region(s) had nonzero totals (expected several) \u2014 likely a field-name mismatch in fetchDisplacementByRegion(), see the [diag] log lines above for the real response shape`
    );
  }

  return { asOf: String(asOfYear ?? thisYear), series };
}

// ---- Lexicon-based discourse tagging: Moral Foundations Dictionary + NRC-style emotion lexicon ----
// Powers the footer's "Discourse-tagging output format" module (see
// index.html, DECISIONS.md "Discourse-tagging module"). Pillar 1 fit per
// the Technical Requirements section: NLP/discourse analysis applied to
// drivers of far-right and ethnonationalist political outcomes (Mudde;
// Norris & Inglehart; Petter & Anton Törnberg).
//
// METHOD, chosen by explicit request over an LLM call (paid Anthropic API
// or a locally-run open model): plain lexicon/word-frequency matching
// against two established, citable academic dictionaries —
//   - Moral Foundations Dictionary (Graham, Haidt & Nosek): care,
//     fairness, loyalty, authority, purity.
//   - An NRC-style emotion lexicon (Mohammad & Turney convention): anger,
//     fear, joy, sadness, plus a positive/negative "tone" pair.
// This is deliberately second-generation NLP by the Törnberg paper's own
// typology — transparent, auditable word-counting, not context-sensitive
// interpretation — chosen for exactly that transparency, for its much
// lighter setup lift (no model weights, no runtime, no API key required
// at all), and because citing these two specific, widely-used dictionaries
// reads as more methodologically credible for a junior-researcher-scoped
// demo than an unvalidated model call would. See DECISIONS.md for the full
// tradeoff writeup.
//
// IMPORTANT CAVEAT: the two lexicons below are a small ILLUSTRATIVE
// STARTER SUBSET (a dozen or so words per category), not the full
// published MFD 2.0 / NRC EmoLex files. Swap in the full dictionaries
// (both freely downloadable for academic use) before treating this
// module's output as a real research instrument rather than a demo.
// Entries may end in "*" as a prefix wildcard, mirroring the real
// dictionaries' own convention (e.g. "author*" matches "authority",
// "authoritarian", "authoritative").
const MORAL_FOUNDATIONS_LEXICON = {
  care: ["care", "compassion", "suffer*", "cruel*", "kind*", "hurt*", "protect*", "safe*", "harm*", "empath*", "nurtur*", "victim*"],
  fairness: ["fair*", "equal*", "justice", "rights", "unfair*", "cheat*", "bias*", "honest*", "discriminat*", "impartial*", "corrupt*"],
  loyalty: ["loyal*", "betray*", "patriot*", "allegiance", "unity", "together", "team*", "nation*", "homeland", "traitor*", "solidarity", "communit*"],
  authority: ["authorit*", "obey*", "order", "law*", "duty", "tradition*", "respect*", "rebel*", "chaos", "hierarch*", "leader*", "legitima*"],
  purity: ["pure*", "sacred", "disgust*", "decent*", "clean*", "sin*", "virtue*", "corrupt*", "degrad*", "moral*", "filth*", "wholesom*"],
};
const EMOTION_LEXICON = {
  anger: ["angr*", "outrage*", "furious", "hostil*", "rage", "resent*", "hate*", "threat*", "attack*", "aggress*"],
  fear: ["afraid", "fear*", "danger*", "anxious", "anxiet*", "worry", "worri*", "panic*", "alarm*", "crisis", "risk*"],
  joy: ["joy*", "happ*", "proud", "pride", "hope*", "celebrat*", "optimis*", "triumph*", "delight*", "cheer*", "encourag*"],
  sadness: ["sad*", "grief", "griev*", "loss", "despair*", "mourn*", "tragedy", "tragic", "sorrow*", "declin*", "struggl*"],
  positive: ["good", "benefit*", "support*", "success*", "strong*", "improve*", "progress*", "opportunit*", "growth", "secur*"],
  negative: ["bad", "fail*", "threat*", "crisis", "declin*", "harm*", "damag*", "weak*", "danger*", "corrupt*"],
};

// Compiles a lexicon (category -> array of literal/"prefix*" entries) into
// per-category RegExp arrays, so scoring is a single pass over the token
// list rather than repeated substring scans.
function compileLexicon(lexicon) {
  const compiled = {};
  for (const [category, entries] of Object.entries(lexicon)) {
    compiled[category] = entries.map((e) =>
      e.endsWith("*")
        ? new RegExp(`^${e.slice(0, -1)}`, "i")
        : new RegExp(`^${e}$`, "i")
    );
  }
  return compiled;
}
const COMPILED_MFD = compileLexicon(MORAL_FOUNDATIONS_LEXICON);
const COMPILED_EMOTION = compileLexicon(EMOTION_LEXICON);

// ---- Legal Outcome Lexicon (starter subset) — powers the new Legal
// case-narrative tagging module (Pillar 1). See DECISIONS.md, "Legal
// case-narrative tagging module." Unlike the Moral Foundations Dictionary
// and the NRC-style emotion lexicon, there is no single canonical
// published "legal outcome dictionary" to cite here — this is an
// in-house starter subset (same "illustrative, not exhaustive" caveat as
// the other two lexicons), covering four common postures a corporate
// Legal Proceedings disclosure takes: an admission/finding of fault
// (liability), a resolved-outcome posture (remediation), an
// agency/enforcement posture (regulatory), and an unresolved/ongoing
// posture (procedural). Scored ALONGSIDE the existing MFD + emotion
// lexicons (not instead of), so legal-narrative entries are directly
// comparable to Congress entries on the moral-foundation/emotion axes,
// with this lexicon adding the domain-specific layer.
const LEGAL_OUTCOME_LEXICON = {
  liability: ["liable", "liabilit*", "negligen*", "breach*", "violat*", "fault*", "wrongdo*", "misconduct", "fraud*", "infring*", "damages"],
  remediation: ["settl*", "resolv*", "remed*", "restitution", "consent decree", "agreed to pay", "penalt*", "fine*", "dismiss*", "vacat*"],
  regulatory: ["sec", "commission", "enforcement", "investigat*", "subpoena*", "complaint", "charge*", "sanction*", "compliance", "consent order"],
  procedural: ["pending", "ongoing", "appeal*", "motion*", "discovery", "hearing", "litigation", "plaintiff*", "defendant*", "court*", "alleg*"],
};
const COMPILED_LEGAL = compileLexicon(LEGAL_OUTCOME_LEXICON);

// Generalized per-category matcher, factored out of what used to be
// scoreText()'s inline scoreCategory() closure, so a lexicon set beyond
// MFD/emotion (e.g. LEGAL_OUTCOME_LEXICON, and eventually a clinical
// lexicon) can reuse the exact same matching/rate/dominant-category logic
// instead of a third hand-rolled copy. scoreText()'s own return shape and
// callers (fetchDiscourseTags(), index.html's entryToCard()) are
// unchanged by this refactor.
function scoreAgainstLexiconSet(tokens, wordCount, compiledLexiconSet) {
  const raw = {};
  const rateOut = {};
  const matched = {};
  const rate = (n) => (wordCount > 0 ? Math.round((n / wordCount) * 1000 * 10) / 10 : 0);
  for (const [cat, compiledCategory] of Object.entries(compiledLexiconSet)) {
    const hits = [];
    for (const tok of tokens) {
      if (compiledCategory.some((re) => re.test(tok))) hits.push(tok);
    }
    raw[cat] = hits.length;
    rateOut[cat] = rate(hits.length);
    matched[cat] = [...new Set(hits)].slice(0, 5);
  }
  return { raw, rate: rateOut, matched };
}

function dominantCategory(rawObj, rateObj, excludeKeys = []) {
  let best = null;
  for (const [cat, raw] of Object.entries(rawObj)) {
    if (excludeKeys.includes(cat)) continue;
    if (raw < MIN_MATCHES) continue;
    if (!best || rateObj[cat] > rateObj[best]) best = cat;
  }
  return best; // null if nothing clears MIN_MATCHES
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Scores one text against both compiled lexicons. Returns rates per 1,000
// words (not raw counts) so a long floor speech and a short one-minute
// statement are comparable, plus the dominant category in each lexicon
// (requiring at least MIN_MATCHES raw hits so a single stray word on a
// short text doesn't get reported as "dominant").
const MIN_MATCHES = 2;
// "Vibe of the Congress" trailing-days parameters (see DECISIONS.md,
// "Discourse-tagging module" \u2014 the 2026-09-13 redesign entry described
// this walk-back as already implemented; it wasn't actually wired into
// fetchDiscourseTags() until the fix below, which is what let
// below-threshold placeholder cards reach the live page).
const DISCOURSE_LOOKBACK_DAYS = 21;
const DISCOURSE_TARGET_COUNT = 4;

// Same "one qualifying entry per calendar day, walk back to fill a
// trailing target" convention as the DISCOURSE_ constants above \u2014 see
// fetchLegalCaseTags() and DECISIONS.md, "Legal case-narrative tagging
// module." Most Legal Proceedings sections are boilerplate ("None," or a
// one-line disclaimer) that won't clear MIN_MATCHES, so the lookback is
// wider than the Congress module's.
const LEGAL_LOOKBACK_DAYS = 30;
const LEGAL_TARGET_COUNT = 4;

// NOTE: the per-category matching loop this used to inline (scoreCategory)
// was factored out into the shared scoreAgainstLexiconSet()/
// dominantCategory() helpers above (see DECISIONS.md, "Legal
// case-narrative tagging module"), so scoreLegalText() below can reuse
// the identical logic. This function's own return shape \u2014 and therefore
// fetchDiscourseTags() and index.html's entryToCard() \u2014 is unchanged.
function scoreText(text) {
  const tokens = (text.toLowerCase().match(/[a-z']+/g) || []);
  const wordCount = tokens.length;

  const mfd = scoreAgainstLexiconSet(tokens, wordCount, COMPILED_MFD);
  const emo = scoreAgainstLexiconSet(tokens, wordCount, COMPILED_EMOTION);

  const dominantFoundation = dominantCategory(mfd.raw, mfd.rate);
  const dominantEmotion = dominantCategory(emo.raw, emo.rate, ["positive", "negative"]);
  const toneScore = Math.round((emo.rate.positive - emo.rate.negative) * 10) / 10;

  return {
    wordCount,
    moralFoundations: mfd.rate,
    dominantFoundation,
    // Matched-word list is what gets surfaced in the UI (see index.html)
    // \u2014 showing the literal dictionary hits is more auditable than a
    // prose excerpt. See DECISIONS.md, "Discourse-tagging module."
    matchedKeywords: { ...mfd.matched, ...emo.matched },
    emotions: { anger: emo.rate.anger, fear: emo.rate.fear, joy: emo.rate.joy, sadness: emo.rate.sadness },
    dominantEmotion,
    tone: { positive: emo.rate.positive, negative: emo.rate.negative, score: toneScore },
  };
}

// ---- Scores text against the Legal Outcome Lexicon + the existing MFD
// and emotion lexicons \u2014 powers the Legal case-narrative tagging module
// (Pillar 1). Scoring the same MFD/emotion lexicons here too (not just
// the legal-specific one) is deliberate: it keeps legal-narrative entries
// directly comparable to Congress entries on those two axes, with
// dominantLegalCategory as the added domain-specific layer. See
// DECISIONS.md, "Legal case-narrative tagging module."
function scoreLegalText(text) {
  const tokens = (text.toLowerCase().match(/[a-z']+/g) || []);
  const wordCount = tokens.length;

  const legal = scoreAgainstLexiconSet(tokens, wordCount, COMPILED_LEGAL);
  const mfd = scoreAgainstLexiconSet(tokens, wordCount, COMPILED_MFD);
  const emo = scoreAgainstLexiconSet(tokens, wordCount, COMPILED_EMOTION);

  const dominantLegalCategory = dominantCategory(legal.raw, legal.rate);
  const dominantFoundation = dominantCategory(mfd.raw, mfd.rate);
  const dominantEmotion = dominantCategory(emo.raw, emo.rate, ["positive", "negative"]);
  const toneScore = Math.round((emo.rate.positive - emo.rate.negative) * 10) / 10;

  return {
    wordCount,
    legalCategories: legal.rate,
    dominantLegalCategory,
    moralFoundations: mfd.rate,
    dominantFoundation,
    matchedKeywords: { ...legal.matched, ...mfd.matched, ...emo.matched },
    emotions: { anger: emo.rate.anger, fear: emo.rate.fear, joy: emo.rate.joy, sadness: emo.rate.sadness },
    dominantEmotion,
    tone: { positive: emo.rate.positive, negative: emo.rate.negative, score: toneScore },
  };
}

// Builds a context excerpt centered on the FIRST matched dictionary word,
// rather than a blind first-N-characters slice \u2014 added by request so cards
// show real surrounding context instead of only a bare word list (see
// DECISIONS.md, "Discourse-tagging module," the excerpt-context entry).
// Falls back to a plain lead-in slice if no matched word can be located
// (shouldn't happen for an entry that already cleared MIN_MATCHES, but
// kept defensive). Congressional Record floor-speech text is a US
// government work product, not subject to copyright, so quoting a window
// of it verbatim is not a reproduction concern the way an external
// copyrighted source would be.
function buildExcerpt(text, matchedWords, windowChars = 160) {
  const words = [...new Set((matchedWords || []).filter(Boolean))];
  let pos = -1;
  for (const w of words) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`\\b${esc}`, "i").exec(text);
    if (m) { pos = m.index; break; }
  }
  if (pos === -1) {
    return text.slice(0, 220) + (text.length > 220 ? "\u2026" : "");
  }
  const start = Math.max(0, pos - windowChars);
  const end = Math.min(text.length, pos + windowChars);
  return (start > 0 ? "\u2026" : "") + text.slice(start, end).trim() + (end < text.length ? "\u2026" : "");
}


// Official daily speech transcripts \u2014 fits the already-logged input
// scope ("public speech transcripts, official party platform
// publications... not private citizens' social media"). Fully keyless in
// the sense that GovInfo/api.data.gov accepts the shared "DEMO_KEY" with
// no registration at all, at a low shared rate limit; GOVINFO_API_KEY is
// an optional upgrade to a personal free key if that quota proves too
// tight for the daily schedule.
//
// CAVEAT: the collections -> granules -> granule-text shape and required
// params (offsetMark, pageSize) below were confirmed 2026-09-12 against
// GPO's own API README and sample responses
// (https://github.com/usgpo/api), after the first real run's HTTP 400
// turned out to be a missing offsetMark param and a mistaken dateIssued
// field read \u2014 see the inline FIX comments below for what changed. The
// granule-list response's exact class/title fields for distinguishing
// floor speech from procedural material are still not fully confirmed,
// which is why isFloorSpeech() below falls back gracefully rather than
// hard-filtering on an assumed field name.
//
// BUG FOUND AND FIXED (2026-09-14, caught via a live screenshot showing
// three of four footer cards as "Mixed / below threshold" placeholders):
// DECISIONS.md's 2026-09-13 "Vibe of the Congress" entry describes this
// function as already walking backward through days and skipping any day
// with nothing that clears MIN_MATCHES \u2014 but the function actually
// shipped only pulled granules from a single most-recent package and
// pushed every one of them regardless of whether anything qualified. That
// mismatch (documented vs. actual behavior) is exactly what produced the
// placeholder cards. This rewrite is the walk-back the docs already
// claimed: it fetches a multi-day window of CREC packages, scores every
// floor-speech candidate within each day, keeps only that day's single
// strongest QUALIFYING granule, and skips the day entirely (moving to the
// next-oldest package) if nothing clears threshold \u2014 so a "below
// threshold" card should no longer be constructible from this function's
// output at all.
async function fetchDiscourseTags() {
  const key = process.env.GOVINFO_API_KEY || "DEMO_KEY";

  // Fetch a wider window of packages up front (one call), then walk them
  // day-by-day, instead of re-querying collections/CREC per candidate day
  // \u2014 fewer requests against the shared DEMO_KEY's low rate limit.
  const since = new Date(Date.now() - DISCOURSE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + "T00:00:00Z";
  const collectionsUrl = `https://api.govinfo.gov/collections/CREC/${since}?offsetMark=*&pageSize=${DISCOURSE_LOOKBACK_DAYS + 5}&api_key=${key}`;
  const collectionsData = await safeFetchJson(collectionsUrl);
  const packages = collectionsData?.packages ?? [];
  if (!packages.length) throw new Error("GovInfo: no recent CREC packages found");

  // Sort most-recent-first by the date embedded in packageId (CREC
  // packageIds are always "CREC-YYYY-MM-DD") rather than trusting the
  // collections response's own ordering, which the original write-up
  // assumed without confirming \u2014 flagged as an unverified assumption in
  // the 2026-09-13 entry; sorting here removes the need to trust it.
  const sorted = [...packages]
    .filter((p) => /CREC-\d{4}-\d{2}-\d{2}/.test(p.packageId ?? ""))
    .sort((a, b) => b.packageId.localeCompare(a.packageId));

  const isFloorSpeech = (g) => {
    const cls = (g.granuleClass ?? g.docClass ?? "").toUpperCase();
    if (cls) return cls === "HOUSE" || cls === "SENATE";
    return !/daily digest|front matter/i.test(g.title ?? "");
  };

  const entries = [];
  const seenDates = new Set();

  for (const pkg of sorted) {
    if (entries.length >= DISCOURSE_TARGET_COUNT) break;
    const packageId = pkg.packageId;
    const date = packageId.match(/CREC-(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date || seenDates.has(date)) continue;
    seenDates.add(date);

    try {
      const granulesUrl = `https://api.govinfo.gov/packages/${packageId}/granules?offsetMark=*&pageSize=20&api_key=${key}`;
      const granulesData = await safeFetchJson(granulesUrl);
      const allGranules = granulesData?.granules ?? [];
      if (!allGranules.length) continue; // no granules this day; try the next-oldest package

      const floorSpeech = allGranules.filter(isFloorSpeech);
      const candidates = (floorSpeech.length ? floorSpeech : allGranules).slice(0, 8);

      // Score every candidate for the day, but keep only the single
      // strongest QUALIFYING one (highest combined dominant-category
      // rate) \u2014 a day contributes at most one card, same as the design
      // DECISIONS.md already described.
      let best = null;
      for (const g of candidates) {
        try {
          const htmUrl = `https://api.govinfo.gov/packages/${packageId}/granules/${g.granuleId}/htm?api_key=${key}`;
          const html = await safeFetchText(htmUrl);
          const text = stripHtml(html);
          if (text.length < 200) continue; // skip near-empty granules
          const scored = scoreText(text);
          if (!scored.dominantFoundation && !scored.dominantEmotion) continue; // doesn't clear MIN_MATCHES \u2014 not a candidate
          const strength =
            (scored.dominantFoundation ? scored.moralFoundations[scored.dominantFoundation] : 0) +
            (scored.dominantEmotion ? scored.emotions[scored.dominantEmotion] : 0);
          if (!best || strength > best.strength) {
            best = { strength, granuleId: g.granuleId, title: g.title ?? "(untitled granule)", text, scored };
          }
        } catch (err) {
          console.error(`[warn] discourse-tagging: skipped granule ${g.granuleId}: ${err.message}`);
        }
      }

      if (!best) continue; // nothing this day cleared threshold; try the next-oldest package

      const matchedWords = [
        ...(best.scored.dominantFoundation ? best.scored.matchedKeywords[best.scored.dominantFoundation] ?? [] : []),
        ...(best.scored.dominantEmotion ? best.scored.matchedKeywords[best.scored.dominantEmotion] ?? [] : []),
      ];
      entries.push({
        granuleId: best.granuleId,
        title: best.title,
        date,
        excerpt: buildExcerpt(best.text, matchedWords),
        ...best.scored,
      });
    } catch (err) {
      console.error(`[warn] discourse-tagging: skipped package ${packageId}: ${err.message}`);
    }
  }

  if (!entries.length) throw new Error("GovInfo: no qualifying granules found in the trailing lookback window");

  return {
    asOf: entries[0]?.date ?? null,
    source: "GovInfo Congressional Record (CREC)",
    method: "Lexicon-based scoring \u2014 Moral Foundations Dictionary + NRC-style emotion lexicon (starter subset, see fetch-ticker-data.mjs)",
    entries,
  };
}

// ---- Legal case-narrative tagging: SEC EDGAR Legal Proceedings sections ----
// Powers the new "Legal case-narrative tagging module" footer module (see
// index.html, DECISIONS.md "Legal case-narrative tagging module"). Pillar
// 1 fit (Strange): a company's disclosed legal exposure is itself a
// structural-power signal, same "who holds leverage" test as the
// Democracy module's extension. This is ADDITIVE to fetchDiscourseTags()
// above \u2014 "Vibe of the Congress" is unchanged \u2014 and deliberately stays
// lexicon-based/second-generation for the same interpretability reasons
// already decided for the Congress module on 2026-09-12; see
// scoreLegalText() above.
//
// SOURCE: SEC's own EDGAR Full-Text Search API (efts.sec.gov), keyless,
// official, real-time per SEC's documentation \u2014 chosen over SEC
// Litigation Releases (too sparse: a handful per week, not daily volume)
// and over paid third-party SEC wrappers (unnecessary; SEC's own search
// is free). Queries recent 10-K/10-Q/8-K filings, fetches each hit's
// actual filing document, and locates the Legal Proceedings section
// (Item 3, or Item 1 in some 10-Qs) by heading, extracting text up to the
// next "Item" heading.
//
// USER-AGENT: uses SEC_UA (an honestly-identifying app+contact string),
// NOT BROWSER_UA \u2014 see the SEC_UA constant's own comment and
// DECISIONS.md for why this differs from the GDELT/UNHCR convention.
// PLACEHOLDER CONTACT EMAIL must be replaced before unattended use.
//
// CAVEAT (same pattern as fetchSPR/fetchGenerationMix/fetchGiniSeries/
// fetchDemocracySeries): written without a live test call (no network
// egress in this build environment) \u2014 the efts.sec.gov query params and
// the Item-3 heading regex are per SEC's public documentation and typical
// filing structure, but unconfirmed against a real response. Verify the
// first real Action run: does a hit's filing actually contain a
// locatable Legal Proceedings section, and does the heading regex miss
// any real-world heading variants (e.g. "Item 1. Legal Proceedings" in a
// 10-Q vs. "Item 3. Legal Proceedings" in a 10-K)?
//
// Same "one qualifying entry per calendar day, walk back to fill a
// trailing target" shape as fetchDiscourseTags() \u2014 see
// LEGAL_LOOKBACK_DAYS/LEGAL_TARGET_COUNT above. A filing whose Legal
// Proceedings section is boilerplate ("None," or a one-line disclaimer)
// won't clear MIN_MATCHES and is skipped, not padded.
async function fetchLegalCaseTags() {
  const ITEM_HEADING_RE = /item\s*[13][a-z]?\.?\s*legal\s+proceedings/i;
  const NEXT_ITEM_RE = /item\s*\d[a-z]?\.?\s+[a-z]/i;
  const MAX_SECTION_CHARS = 6000;

  const extractLegalProceedings = (text) => {
    const m = ITEM_HEADING_RE.exec(text);
    if (!m) return null;
    const rest = text.slice(m.index + m[0].length);
    // Find the next "Item N." heading after this one to bound the
    // section; if none is found (e.g. truncated fetch), cap by length
    // instead.
    const nextMatch = NEXT_ITEM_RE.exec(rest.slice(50)); // skip a few chars so the same heading's own trailing text can't self-match
    const end = nextMatch ? 50 + nextMatch.index : Math.min(rest.length, MAX_SECTION_CHARS);
    return rest.slice(0, Math.min(end, MAX_SECTION_CHARS)).trim();
  };

  const since = new Date(Date.now() - LEGAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);
  const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22legal+proceedings%22&forms=10-K,10-Q,8-K&startdt=${since}&enddt=${until}`;
  const searchData = await safeFetchJson(searchUrl, { headers: { "User-Agent": SEC_UA } });
  const hits = searchData?.hits?.hits ?? [];
  console.log("[diag] efts.sec.gov sample hit:", JSON.stringify(hits[0] ?? null));
  console.log("[diag] efts.sec.gov hit count:", hits.length);
  if (!hits.length) throw new Error("SEC EDGAR: no full-text-search hits returned");

  // Sort most-recent-first by filing date and walk them, keeping at most
  // one qualifying entry per calendar day \u2014 same convention as
  // fetchDiscourseTags().
  const withDate = hits
    .map((h) => ({ hit: h, date: h?._source?.file_date ?? h?._source?.filedAt ?? null }))
    .filter((x) => x.date)
    .sort((a, b) => b.date.localeCompare(a.date));

  const entries = [];
  const seenDates = new Set();

  for (const { hit, date } of withDate) {
    if (entries.length >= LEGAL_TARGET_COUNT) break;
    if (seenDates.has(date)) continue;

    const src = hit._source ?? {};
    const accessionNo = src.adsh ?? hit._id;
    const cik = Array.isArray(src.ciks) ? src.ciks[0] : src.cik;
    const company = Array.isArray(src.display_names) ? src.display_names[0] : (src.display_names ?? "(unknown filer)");
    const form = src.root_form ?? src.form ?? "(unknown form)";
    // The filing's primary document URL; efts.sec.gov results carry the
    // pieces needed to reconstruct it (cik + accession + primary doc),
    // per SEC's documented Archives path convention.
    const adshNoDashes = String(accessionNo ?? "").replace(/-/g, "");
    const primaryDoc = src.adsh_document ?? src.primary_doc ?? null;
    if (!cik || !adshNoDashes || !primaryDoc) continue; // can't build a fetchable URL from this hit \u2014 skip to the next

    seenDates.add(date);
    try {
      const docUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${adshNoDashes}/${primaryDoc}`;
      const html = await safeFetchText(docUrl, { headers: { "User-Agent": SEC_UA } });
      const text = stripHtml(html);
      const section = extractLegalProceedings(text);
      if (!section || section.length < 200) continue; // no locatable/substantial Legal Proceedings text this filing \u2014 try the next

      const scored = scoreLegalText(section);
      if (!scored.dominantLegalCategory && !scored.dominantFoundation && !scored.dominantEmotion) continue; // doesn't clear MIN_MATCHES on any axis

      const matchedWords = [
        ...(scored.dominantLegalCategory ? scored.matchedKeywords[scored.dominantLegalCategory] ?? [] : []),
        ...(scored.dominantFoundation ? scored.matchedKeywords[scored.dominantFoundation] ?? [] : []),
        ...(scored.dominantEmotion ? scored.matchedKeywords[scored.dominantEmotion] ?? [] : []),
      ];

      entries.push({
        accessionNo,
        company,
        form,
        date,
        excerpt: buildExcerpt(section, matchedWords),
        ...scored,
      });
    } catch (err) {
      console.error(`[warn] legal-tagging: skipped filing ${accessionNo}: ${err.message}`);
    }
  }

  if (!entries.length) throw new Error("SEC EDGAR: no qualifying Legal Proceedings sections found in the trailing lookback window");

  return {
    asOf: entries[0]?.date ?? null,
    source: "SEC EDGAR (Legal Proceedings sections, 10-K/10-Q/8-K)",
    method: "Lexicon-based scoring \u2014 Legal Outcome Lexicon + Moral Foundations Dictionary + NRC-style emotion lexicon (starter subset, see fetch-ticker-data.mjs)",
    entries,
  };
}

// NOT in the `fetchers` pipeline below as of the core-set review: this
// hardcodes change: "n/a" (single-point read, no prior-year diff ever
// fetched), so it carries no data-driven indication of movement and was
// dropped from the core ticker on that basis. Left defined, not deleted,
// in case a future pass adds the second-year fetch + diff this would need
// to earn a spot back.
async function fetchGini() {
  const key = process.env.CENSUS_API_KEY; // optional
  const now = new Date().getFullYear();
  let lastErr;
  for (const year of [now - 1, now - 2, now - 3]) {
    try {
      const url = `https://api.census.gov/data/${year}/acs/acs1?get=NAME,B19083_001E&for=us:1${
        key ? `&key=${key}` : ""
      }`;
      const data = await safeFetchJson(url);
      const row = data[1];
      const gini = parseFloat(row[1]);
      return {
        id: "gini-us",
        name: "Gini Coefficient \u2014 US Disposable Income (Census Bureau)",
        value: gini.toFixed(3),
        change: "n/a", // single-point annual read; no prior-year diff fetched here
        series: "sage",
        asOf: String(year),
        note: "Annual ACS 1-year release \u2014 value is static between updates.",
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Census Gini: no year worked (${lastErr?.message})`);
}

// ---- US Census: White-Black median household income gap (ACS 1-year) ----
// NOT in the `fetchers` pipeline below \u2014 same reasoning as fetchGini()
// above: change is hardcoded "n/a", no diff is computed, dropped from the
// core ticker on that basis, function kept for a possible future upgrade.
async function fetchIncomeGap() {
  const key = process.env.CENSUS_API_KEY; // optional
  const now = new Date().getFullYear();
  let lastErr;
  for (const year of [now - 1, now - 2, now - 3]) {
    try {
      const url = `https://api.census.gov/data/${year}/acs/acs1?get=NAME,B19013A_001E,B19013B_001E&for=us:1${
        key ? `&key=${key}` : ""
      }`;
      const data = await safeFetchJson(url);
      const row = data[1];
      const white = parseFloat(row[1]);
      const black = parseFloat(row[2]);
      if (Number.isNaN(white) || Number.isNaN(black)) throw new Error("Census: non-numeric income value");
      const gap = white - black;
      return {
        id: "income-gap-us",
        name: "White\u2013Black Median Household Income Gap (Census Bureau, annual)",
        value: `$${Math.round(gap).toLocaleString("en-US")}`,
        change: "n/a",
        series: "ristra",
        asOf: String(year),
        note: "Annual ACS 1-year release \u2014 value is static between updates.",
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Census income gap: no year worked (${lastErr?.message})`);
}

async function main() {
  const existing = await loadExisting();
  const fetchers = [fetchFred, fetchLaborShare, fetchDollarIndex, fetchBls, fetchWealthShare, fetchIncomeShareUS, fetchHousingPriceIndex, fetchSPR, fetchEnergyVolatility, fetchDisplacement];
  const results = [];
  for (const fn of fetchers) {
    try {
      results.push(await fn());
    } catch (err) {
      console.error(`[warn] ${fn.name} failed: ${err.message}`);
      // Fall back to whatever was already published for this indicator, if any.
      const idGuess = {
        fetchFred: "treasury-spread",
        fetchLaborShare: "labor-share",
        fetchDollarIndex: "dollar-index",
        fetchBls: "unemployment-gap",
        fetchWealthShare: "wealth-share-top1",
        fetchIncomeShareUS: "income-share-top1-us",
        fetchHousingPriceIndex: "housing-price-index",
        fetchSPR: "spr-level",
        fetchEnergyVolatility: "energy-price-volatility",
        fetchDisplacement: "forcibly-displaced",
      }[fn.name];
      if (existing[idGuess]) results.push(existing[idGuess]);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    indicators: results,
  };
  await writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT_PATH} with ${results.length} indicator(s).`);

  // Energy module (generation mix): separate output file from the ticker,
  // since it's a chart series rather than a single indicator value — see
  // DECISIONS.md, "Energy module visualizations". Same
  // fall-back-to-last-published behavior as above, so one bad EIA response
  // doesn't blank out the chart. (crudeImports was removed 2026-09-11 by
  // request \u2014 see DECISIONS.md changelog.)
  const existingEnergy = await loadExistingEnergy();
  const energyOutput = { generatedAt: new Date().toISOString() };

  try {
    energyOutput.generationMix = await fetchGenerationMix();
  } catch (err) {
    console.error(`[warn] fetchGenerationMix failed: ${err.message}`);
    if (existingEnergy.generationMix) energyOutput.generationMix = existingEnergy.generationMix;
  }

  await writeFile(ENERGY_OUT_PATH, JSON.stringify(energyOutput, null, 2) + "\n", "utf8");
  console.log(`Wrote ${ENERGY_OUT_PATH}.`);

  // Distributional Justice (Pillar 2) panel: US Gini time series, own
  // sibling output file for the same reason energy-data.json is separate
  // from ticker-data.json — this is a chart series, not a single ticker
  // value. Same fall-back-to-last-published behavior on fetch failure.
  const existingGini = await loadExistingGini();
  let giniOutput = { generatedAt: new Date().toISOString() };
  try {
    const gini = await fetchGiniSeries();
    giniOutput = { generatedAt: giniOutput.generatedAt, ...gini };
  } catch (err) {
    console.error(`[warn] fetchGiniSeries failed: ${err.message}`);
    if (existingGini.series) {
      giniOutput = { ...existingGini, generatedAt: giniOutput.generatedAt };
    }
  }
  await writeFile(GINI_OUT_PATH, JSON.stringify(giniOutput, null, 2) + "\n", "utf8");
  console.log(`Wrote ${GINI_OUT_PATH}.`);

  // Structural Power & Political Economy (Pillar 1) panel: Student Loans
  // Owned and Securitized time series — own sibling output file, same
  // reason gini-data.json/energy-data.json are separate from
  // ticker-data.json (a chart series, not a single ticker value). Same
  // fall-back-to-last-published behavior on fetch failure.
  const existingStudentLoan = await loadExistingStudentLoan();
  let studentLoanOutput = { generatedAt: new Date().toISOString() };
  try {
    const studentLoan = await fetchStudentLoanSeries();
    studentLoanOutput = { generatedAt: studentLoanOutput.generatedAt, ...studentLoan };
  } catch (err) {
    console.error(`[warn] fetchStudentLoanSeries failed: ${err.message}`);
    if (existingStudentLoan.series) {
      studentLoanOutput = { ...existingStudentLoan, generatedAt: studentLoanOutput.generatedAt };
    }
  }
  await writeFile(STUDENT_LOAN_OUT_PATH, JSON.stringify(studentLoanOutput, null, 2) + "\n", "utf8");
  console.log(`Wrote ${STUDENT_LOAN_OUT_PATH}.`);

  // Peace and Conflict (Pillar 3) panel: forcibly displaced persons by
  // region of origin, latest year \u2014 own sibling output file, same
  // reason gini-data.json/energy-data.json/student-loan-data.json are
  // separate from ticker-data.json (a chart series/breakdown, not a
  // single ticker value). Same fall-back-to-last-published behavior on
  // fetch failure.
  const existingPeace = await loadExistingPeace();
  let peaceOutput = { generatedAt: new Date().toISOString() };
  try {
    const peace = await fetchDisplacementByRegion();
    peaceOutput = { generatedAt: peaceOutput.generatedAt, ...peace };
  } catch (err) {
    console.error(`[warn] fetchDisplacementByRegion failed: ${err.message}`);
    if (existingPeace.series) {
      peaceOutput = { ...existingPeace, generatedAt: peaceOutput.generatedAt };
    }
  }
  await writeFile(PEACE_OUT_PATH, JSON.stringify(peaceOutput, null, 2) + "\n", "utf8");
  console.log(`Wrote ${PEACE_OUT_PATH}.`);

  // Discourse-tagging module (Pillar 1): lexicon-scored Congressional
  // Record excerpts \u2014 own sibling output file, same reason the other
  // module JSONs are separate from ticker-data.json (a set of tagged
  // entries, not a single ticker value). Same fall-back-to-last-published
  // behavior on fetch failure.
  const existingDiscourse = await loadExistingDiscourse();
  let discourseOutput = { generatedAt: new Date().toISOString() };
  try {
    const discourse = await fetchDiscourseTags();
    let entries = discourse.entries ?? [];
    // Backfill (added 2026-09-14, by request): if the trailing-days
    // walk-back still comes back short of DISCOURSE_TARGET_COUNT \u2014 e.g.
    // GovInfo's lookback window ran out of qualifying days \u2014 top up with
    // the most recent previously-published entries not already included,
    // deduped by granuleId, instead of shipping fewer populated cards (the
    // "non-loading panels" the live screenshot showed).
    if (entries.length < DISCOURSE_TARGET_COUNT && existingDiscourse.entries?.length) {
      const seen = new Set(entries.map((e) => e.granuleId));
      for (const old of existingDiscourse.entries) {
        if (entries.length >= DISCOURSE_TARGET_COUNT) break;
        if (seen.has(old.granuleId)) continue;
        entries.push(old);
        seen.add(old.granuleId);
      }
    }
    discourseOutput = { generatedAt: discourseOutput.generatedAt, ...discourse, entries };
  } catch (err) {
    console.error(`[warn] fetchDiscourseTags failed: ${err.message}`);
    if (existingDiscourse.entries) {
      discourseOutput = { ...existingDiscourse, generatedAt: discourseOutput.generatedAt };
    }
  }
  await writeFile(DISCOURSE_OUT_PATH, JSON.stringify(discourseOutput, null, 2) + "\n", "utf8");
  console.log(`Wrote ${DISCOURSE_OUT_PATH}.`);

  // Democracy (Pillar 1) panel: US Liberal Democracy Index time series —
  // own sibling output file, same reason gini-data.json/student-loan-data.json
  // are separate from ticker-data.json (a chart series, not a single ticker
  // value). Same fall-back-to-last-published behavior on fetch failure.
  const existingDemocracy = await loadExistingDemocracy();
  let democracyOutput = { generatedAt: new Date().toISOString() };
  try {
    const democracy = await fetchDemocracySeries();
    democracyOutput = { generatedAt: democracyOutput.generatedAt, ...democracy };
  } catch (err) {
    console.error(`[warn] fetchDemocracySeries failed: ${err.message}`);
    if (existingDemocracy.series) {
      democracyOutput = { ...existingDemocracy, generatedAt: democracyOutput.generatedAt };
    }
  }
  await writeFile(DEMOCRACY_OUT_PATH, JSON.stringify(democracyOutput, null, 2) + "\n", "utf8");
  console.log(`Wrote ${DEMOCRACY_OUT_PATH}.`);

  // Legal case-narrative tagging module (Pillar 1): SEC EDGAR Legal
  // Proceedings sections \u2014 own sibling output file, same reason
  // discourse-data.json/peace-data.json are separate from
  // ticker-data.json (a set of tagged entries, not a single ticker
  // value). Same fall-back-to-last-published behavior on fetch failure.
  // Additive to, not a replacement for, discourse-data.json/"Vibe of the
  // Congress" \u2014 see DECISIONS.md, "Legal case-narrative tagging module."
  const existingLegal = await loadExistingLegal();
  let legalOutput = { generatedAt: new Date().toISOString() };
  try {
    const legal = await fetchLegalCaseTags();
    legalOutput = { generatedAt: legalOutput.generatedAt, ...legal };
  } catch (err) {
    console.error(`[warn] fetchLegalCaseTags failed: ${err.message}`);
    if (existingLegal.entries) {
      legalOutput = { ...existingLegal, generatedAt: legalOutput.generatedAt };
    }
  }
  await writeFile(LEGAL_OUT_PATH, JSON.stringify(legalOutput, null, 2) + "\n", "utf8");
  console.log(`Wrote ${LEGAL_OUT_PATH}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
