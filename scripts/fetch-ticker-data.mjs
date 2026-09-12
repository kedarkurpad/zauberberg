#!/usr/bin/env node
/**
 * Fetches ticker indicators server-side (so API keys never touch the browser)
 * and writes /ticker-data.json for the static page to read. Also fetches the
 * Energy module's generation-mix chart dataset and writes /energy-data.json
 * alongside it, and the Distributional Justice module's US Gini time series,
 * writing /gini-data.json alongside both.
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
 *
 * Design notes (see DECISIONS.md, Technical Requirements):
 *   - Wired up and in the core ticker: FRED (T10Y2Y, labor share, Nominal
 *     Broad Dollar Index, WTI 20-day realized volatility, US home-price
 *     YoY growth), BLS (unemployment gap), OWID/WID (global top 1% wealth
 *     share, US top 1% income share), EIA (Strategic Petroleum
 *     Reserve). GDELT tone was dropped by request \u2014 see DECISIONS.md
 *     changelog. Tier 2 (ECB spread, OFAC additions, EU ETS/Ember) is
 *     intentionally deferred.
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
  const fetchers = [fetchFred, fetchLaborShare, fetchDollarIndex, fetchBls, fetchWealthShare, fetchIncomeShareUS, fetchHousingPriceIndex, fetchSPR, fetchEnergyVolatility];
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
