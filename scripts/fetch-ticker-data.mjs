#!/usr/bin/env node
/**
 * Fetches ticker indicators and module chart data server-side (so API keys
 * never touch the browser) and writes the static JSON files the page reads:
 *   ticker-data.json, energy-data.json, gini-data.json,
 *   student-loan-data.json, peace-data.json, discourse-data.json,
 *   democracy-data.json.
 *
 * Run by .github/workflows/update-ticker-data.yml on a schedule.
 *
 * Full rationale, tradeoffs, and change history for every indicator and
 * module lives in DECISIONS.md — this file's comments cover only what's
 * needed to safely modify the code (non-obvious gotchas, unconfirmed
 * assumptions, guardrails), not the "why we chose this" narrative.
 *
 * Secrets expected in the repo (Settings -> Secrets and variables -> Actions):
 *   FRED_API_KEY    - https://fredaccount.stlouisfed.org/apikeys (free)
 *   BLS_API_KEY     - https://data.bls.gov/registrationEngine/ (free, optional;
 *                     falls back to an unauthenticated call at a lower quota)
 *   CENSUS_API_KEY  - https://api.census.gov/data/key_signup.html (free,
 *                     optional; only used by the dormant fetchGini/fetchIncomeGap)
 *   EIA_API_KEY     - https://www.eia.gov/opendata/register.php (free,
 *                     REQUIRED for fetchSPR/fetchGenerationMix — EIA has no
 *                     unauthenticated fallback)
 *   GOVINFO_API_KEY - https://api.govinfo.gov/docs/ (free, optional — falls
 *                     back to the shared "DEMO_KEY", 30/hr & 50/day cap)
 *
 * If a fetch fails, we keep whatever value was already published for that
 * indicator/module rather than crashing the run or writing a blank.
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

const fmtPP = (n, digits = 1) => `${n.toFixed(digits)}pp`;
const fmtSigned = (n, digits = 1, suffix = "pp") =>
  `${n >= 0 ? "+" : ""}${n.toFixed(digits)}${suffix}`;

// Generic "read a JSON file, or return a fallback if it's missing/invalid"
// helper — used for every module's fall-back-to-last-published behavior.
async function readJsonOr(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadExistingTicker() {
  const parsed = await readJsonOr(OUT_PATH, { indicators: [] });
  const byId = {};
  for (const ind of parsed.indicators ?? []) byId[ind.id] = ind;
  return byId;
}

async function safeFetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function safeFetchText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// Some sources (GDELT, historically) are flaky from CI runners; browser
// UA occasionally matters for hosts that reject default fetch UAs.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// =====================================================================
// Core ticker indicators
// =====================================================================

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
fetchFred.indicatorId = "treasury-spread";

// ---- FRED: Labor Share of Income (Penn World Table via FRED) ----
// LABSHPUSA156NRUG (units: Ratio) rather than BLS's index-based
// PRS84006173 — see DECISIONS.md for why.
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
    // Value-polarity exception: rising labor share reads as good under
    // this project's distributive-justice framing, so its delta overrides
    // the neutral terracotta with turquoise(up)/ochre(down) — see the
    // [data-polarity] CSS rules in index.html and DECISIONS.md.
    polarity: "good-up",
    asOf: obs[0].date,
    note: "Annual release \u2014 value is static between updates. Source has no scheduled next release as of 2026-09-11.",
  };
}
fetchLaborShare.indicatorId = "labor-share";

// ---- FRED: Nominal Broad U.S. Dollar Index ----
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
fetchDollarIndex.indicatorId = "dollar-index";

// ---- BLS: Black-White unemployment rate gap ----
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
    series: "sage", // Pillar 2 token — see the Visual Encoding Registry
    cadence: "monthly",
    asOf: `${black[0].year}-${black[0].period.replace("M", "")}`,
  };
}
fetchBls.indicatorId = "unemployment-gap";

// ---- OWID (WID.world-sourced) percent-indicator CSV helper ----
// Minimal quoted-field-aware CSV line parser; OWID exports are simple but
// this avoids silently misaligning columns if a field is ever quoted.
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
  // OWID's export already stores these as percent ("Unit: %"), not a 0-1
  // fraction like WID.world's raw source — do not multiply by 100.
  return {
    latestPct: parseFloat(latest[valueIdx]),
    prevPct: parseFloat(prev[valueIdx]),
    year: latest[yearIdx],
  };
}

// ---- OWID (WID.world-sourced): Global Top 1% Wealth Share ----
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
    // Value-polarity exception: rising top-1% concentration reads as bad,
    // so this overrides sage with ochre(up)/turquoise(down). Note ochre is
    // also spr-level's plain Pillar-4 identity color — known, accepted
    // collision; see DECISIONS.md.
    polarity: "bad-up",
    asOf: year,
    note: "Annual release \u2014 value is static between WID.world's yearly updates.",
  };
}
fetchWealthShare.indicatorId = "wealth-share-top1";

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
    series: "sage",
    cadence: "annual",
    polarity: "bad-up", // same reasoning as wealth-share-top1
    asOf: year,
    note: "Annual release \u2014 value is static between WID.world's yearly updates.",
  };
}
fetchIncomeShareUS.indicatorId = "income-share-top1-us";

// ---- FRED: US Home Price Index, YoY growth ----
// Ticker VALUE is YoY appreciation, not the raw index level (a bare price
// series/level would read as supply-and-demand economics). "change" is
// the month-over-month shift in that YoY rate (whether asset-wealth gains
// are accelerating), not a plain level diff. No `polarity` field — see
// DECISIONS.md for why this doesn't clear the same normative bar
// wealth-share-top1/income-share-top1-us do.
//
// CSUSHPISA is the seasonally-adjusted series; do not swap in the NSA
// variant (CSUSHPINSA) or the YoY figure reabsorbs seasonal noise.
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
    note: "Value is year-over-year home-price appreciation; change is the month-over-month shift in that YoY rate, not a simple index-point diff.",
  };
}
fetchHousingPriceIndex.indicatorId = "housing-price-index";

// ---- EIA: Strategic Petroleum Reserve, weekly crude oil ending stocks ----
// A held reserve level is energy-security-as-leverage (Mitchell), not a
// bare commodity price, per the Pillar 4 relevance test. Series is in
// thousand barrels; converted to million barrels for display.
// CAVEAT: written without a live test call — verify the response shape
// (response.data[].period / .value) on the first real run.
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
fetchSPR.indicatorId = "spr-level";

// ---- FRED: Energy price volatility (WTI crude, 20-trading-day realized vol) ----
// The SIGNAL is the swing, not the price level (a bare price would fail
// the Pillar 4 relevance test the same way it does for spr-level).
// Pulls ~45 daily closes (DCOILWTICO skips weekends/holidays), takes
// day-over-day log returns over the most recent 20, and annualizes the
// stdev (* sqrt(252)) as a percent. "change" re-runs the same calc on the
// window shifted back one observation.
// CAVEAT: the volatility math itself hasn't been sanity-checked against
// an independent source — verify the first real run's value.
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
    const returns = [];
    for (let i = 0; i < window.length - 1; i++) returns.push(logReturn(window[i], window[i + 1]));
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(252) * 100;
  };

  const latestVol = stdevAnnualized(obs.slice(0, 21));
  const prevVol = stdevAnnualized(obs.slice(1, 22));

  return {
    id: "energy-price-volatility",
    name: "Energy Price Volatility \u2014 WTI 20-Day Realized Vol (FRED: DCOILWTICO)",
    value: `${latestVol.toFixed(1)}%`,
    change: fmtSigned(latestVol - prevVol, 1, "pp"),
    series: "ochre",
    cadence: "daily",
    asOf: obs[0].date,
    note: "Annualized realized volatility of WTI crude over the trailing 20 trading days \u2014 the swing, not the price level, is the Pillar 4 signal.",
  };
}
fetchEnergyVolatility.indicatorId = "energy-price-volatility";

// ---- UNHCR: Forcibly Displaced Persons, Global Total ----
// Sum of refugees + asylum-seekers + IDPs + other people in need of
// international protection (UNHCR's own "forcibly displaced" definition;
// deliberately excludes stand-alone stateless persons). No `polarity`
// field yet — flagged in DECISIONS.md as a candidate, not decided.
//
// Omitting both coo and coa aggregates every row server-side into one
// global row per year, per UNHCR's documented API behavior.
async function fetchDisplacement() {
  const thisYear = new Date().getFullYear();
  const url = `https://api.unhcr.org/population/v1/population/?yearFrom=${thisYear - 2}&yearTo=${thisYear}&columns[]=refugees&columns[]=asylum_seekers&columns[]=idps&columns[]=oip`;
  const data = await safeFetchJson(url, { headers: { "User-Agent": BROWSER_UA } });
  const rows = (data?.items ?? data?.data ?? []).filter((r) => r.year);
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

  // Plausibility guard: UNHCR's published global figure has sat roughly in
  // [100M, 130M] for the past few years. A result far outside a generous
  // [50M, 300M] band is a stronger signal of a parsing bug than reality.
  if (latest < 50 || latest > 300) {
    throw new Error(
      `UNHCR: aggregated global total (${latest.toFixed(1)}M) is outside the plausible [50M, 300M] range \u2014 see the [diag] log lines above`
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
fetchDisplacement.indicatorId = "forcibly-displaced";

// The active core-ticker pipeline. Each fetcher carries its own
// `.indicatorId` (set above) so a failure can fall back to whatever was
// last published for that id, without a separate name->id lookup table.
const TICKER_FETCHERS = [
  fetchFred,
  fetchLaborShare,
  fetchDollarIndex,
  fetchBls,
  fetchWealthShare,
  fetchIncomeShareUS,
  fetchHousingPriceIndex,
  fetchSPR,
  fetchEnergyVolatility,
  fetchDisplacement,
];

// =====================================================================
// Module chart-data fetchers (each writes its own sibling JSON file,
// separate from ticker-data.json, since each is a chart series/breakdown
// rather than a single ticker value)
// =====================================================================

// ---- OWID (V-Dem-sourced): US Liberal Democracy Index, full annual series ----
// Powers the Democracy (Pillar 1) panel. Reuses parseCsvLine() but not
// fetchOwidPercentIndicator(), since LDI is a plain 0\u20131 index, not a
// percent column.
// CAVEAT: written without a live test call — the "liberal-democracy-index"
// grapher slug and column layout are inferred, not confirmed.
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

  // Plausibility guard: LDI is bounded [0, 1] by construction.
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

// ---- FRED: US Household Income Gini Ratio, full annual series ----
// Powers the Distributional Justice (Pillar 2) panel. NOT the same thing
// as the dormant fetchGini() below (a single-point Census ACS read with
// no year-over-year diff) — this pulls the full GINIALLRH history.
// CAVEAT: written without a live test call — shape matches every other
// verified FRED fetcher in this file, so risk is low, but verify.
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

// ---- FRED: Student Loans Owned and Securitized ----
// Powers the (currently unmounted, see DECISIONS.md) Structural Power
// panel. SLOASM is nominally "monthly" but only actually populates
// Mar/Jun/Sep/Dec (other months come back as "." from FRED) — filtered
// out below, not a bug. Values converted from millions to trillions USD.
// This fetcher's series id + JSON shape WAS confirmed against a live
// response (2026-09-11), unlike most others in this file.
async function fetchStudentLoanSeries() {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY not set");
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=SLOASM&api_key=${key}&file_type=json&sort_order=asc&observation_start=2006-01-01`;
  const data = await safeFetchJson(url);
  const obs = (data.observations ?? []).filter((o) => o.value !== ".");
  if (obs.length < 2) throw new Error("FRED: not enough usable SLOASM observations");
  const series = obs.map((o) => ({
    date: o.date,
    trillions: Math.round((parseFloat(o.value) / 1_000_000) * 1000) / 1000,
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
// Powers the Energy module's stacked-area chart. Framed as transition
// politics (Malm; Riofrancos; Mitchell), not a bare supply/demand mix.
// CAVEAT: written without a live test call — verify fueltypeid/sectorid
// facet values and the row shape (row.period/.fueltypeid/.generation) on
// the first real run.
async function fetchGenerationMix() {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error("EIA_API_KEY not set");

  const FUEL_BUCKETS = {
    fossil: ["COW", "PEL", "NG"], // coal, petroleum liquids, natural gas
    nuclear: ["NUC"],
    renewables: ["WND", "SUN", "DPV", "WAT", "GEO", "WWW"], // wind, utility/small-scale solar, hydro, geothermal, wood/waste
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
    length: String(allCodes.length * 8), // ~8 years' worth per fuel type
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

  // Drop the most recent period if it looks partial (well under the prior
  // year's total) so a part-year doesn't render as a misleading share.
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

// ---- UNHCR: Forcibly displaced persons by region of origin ----
// Powers the Peace and Conflict (Pillar 3) panel's grouped bar chart — a
// cross-sectional snapshot (latest year), not a trend line.
//
// Region bucketing is built at fetch time from /countries (country ->
// UNHCR region), not a hardcoded list. Uses coo_all=true to break out
// every origin country as its own row while omitting coa/coa_all so each
// origin's row is already summed across destinations server-side.
async function fetchDisplacementByRegion() {
  const countriesUrl = `https://api.unhcr.org/population/v1/countries/?limit=300`;
  const countriesData = await safeFetchJson(countriesUrl, { headers: { "User-Agent": BROWSER_UA } });
  const countryRows = countriesData?.items ?? countriesData?.data ?? [];
  console.log("[diag] /countries sample row:", JSON.stringify(countryRows[0] ?? null));
  console.log("[diag] /countries row count:", countryRows.length);
  if (!countryRows.length) throw new Error("UNHCR: no usable /countries rows returned");
  const regionByCode = {};
  for (const c of countryRows) {
    const code = c.code ?? c.iso3 ?? c.id;
    const region = c.unhcr_region_name ?? c.unhcrRegionName ?? c.region ?? "Other/unknown";
    if (code) regionByCode[code] = region;
  }

  const thisYear = new Date().getFullYear();
  const popUrl = `https://api.unhcr.org/population/v1/population/?year=${thisYear}&coo_all=true&limit=1000&columns[]=refugees&columns[]=asylum_seekers&columns[]=idps&columns[]=oip`;
  let data = await safeFetchJson(popUrl, { headers: { "User-Agent": BROWSER_UA } });
  let rows = data?.items ?? data?.data ?? [];
  // Fall back one year if the current year has no published rows yet.
  if (!rows.length) {
    const fallbackUrl = `https://api.unhcr.org/population/v1/population/?year=${thisYear - 1}&coo_all=true&limit=1000&columns[]=refugees&columns[]=asylum_seekers&columns[]=idps&columns[]=oip`;
    data = await safeFetchJson(fallbackUrl, { headers: { "User-Agent": BROWSER_UA } });
    rows = data?.items ?? data?.data ?? [];
  }
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
    .slice(0, 7); // top regions only, keeps the bar chart readable

  if (!series.length) throw new Error("UNHCR: could not bucket any by-origin rows into regions");

  // Sanity check: a real global breakdown should span several regions.
  // Fewer than 3 nonzero regions is a stronger signal of a shape mismatch
  // than of reality — fail loudly so main() falls back instead of
  // publishing a misleadingly sparse chart labeled "live."
  if (series.length < 3) {
    throw new Error(
      `UNHCR: only ${series.length} region(s) had nonzero totals (expected several) \u2014 see the [diag] log lines above`
    );
  }

  return { asOf: String(asOfYear ?? thisYear), series };
}

// =====================================================================
// Discourse-tagging module: lexicon-based scoring of Congressional Record
// floor speeches (Moral Foundations Dictionary + an NRC-style emotion
// lexicon). Deliberately second-generation NLP (word-frequency matching),
// chosen over an LLM call for interpretability/setup-lift/credibility —
// see DECISIONS.md, "Discourse-tagging module."
//
// IMPORTANT: the lexicons below are a small illustrative STARTER SUBSET,
// not the full published MFD 2.0 / NRC EmoLex files. Swap in the full
// dictionaries before treating this module's output as a real research
// instrument. Entries may end in "*" as a prefix wildcard (e.g. "author*"
// matches "authority", "authoritarian"), mirroring the real dictionaries'
// own convention.
// =====================================================================

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

// Compiles a lexicon (category -> literal/"prefix*" entries) into
// per-category RegExps, so scoring is a single pass over the token list.
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

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A category is "dominant" only once it clears MIN_MATCHES raw hits, so a
// single stray word on a short text isn't reported as dominant.
const MIN_MATCHES = 2;
const DISCOURSE_LOOKBACK_DAYS = 21;
const DISCOURSE_TARGET_COUNT = 4;

// Scores one text against both lexicons: rates per 1,000 words (so texts
// of different lengths are comparable), the dominant category in each
// lexicon, and up to 5 example matched words per category (surfaced in
// the UI instead of a prose excerpt, for auditability).
function scoreText(text) {
  const tokens = (text.toLowerCase().match(/[a-z']+/g) || []);
  const wordCount = tokens.length;

  const scoreCategory = (compiledCategory) => {
    const hits = [];
    for (const tok of tokens) {
      if (compiledCategory.some((re) => re.test(tok))) hits.push(tok);
    }
    return { raw: hits.length, matched: [...new Set(hits)].slice(0, 5) };
  };

  const rate = (raw) => (wordCount > 0 ? Math.round((raw / wordCount) * 1000 * 10) / 10 : 0);

  const mfdRaw = {}, mfdRate = {}, mfdMatched = {};
  for (const [cat, res] of Object.entries(COMPILED_MFD)) {
    const { raw, matched } = scoreCategory(res);
    mfdRaw[cat] = raw; mfdRate[cat] = rate(raw); mfdMatched[cat] = matched;
  }
  const emoRaw = {}, emoRate = {}, emoMatched = {};
  for (const [cat, res] of Object.entries(COMPILED_EMOTION)) {
    const { raw, matched } = scoreCategory(res);
    emoRaw[cat] = raw; emoRate[cat] = rate(raw); emoMatched[cat] = matched;
  }

  const dominant = (rawObj, rateObj, excludeKeys = []) => {
    let best = null;
    for (const [cat, raw] of Object.entries(rawObj)) {
      if (excludeKeys.includes(cat)) continue;
      if (raw < MIN_MATCHES) continue;
      if (!best || rateObj[cat] > rateObj[best]) best = cat;
    }
    return best;
  };

  const dominantFoundation = dominant(mfdRaw, mfdRate);
  const dominantEmotion = dominant(emoRaw, emoRate, ["positive", "negative"]);
  const toneScore = Math.round((emoRate.positive - emoRate.negative) * 10) / 10;

  return {
    wordCount,
    moralFoundations: mfdRate,
    dominantFoundation,
    matchedKeywords: { ...mfdMatched, ...emoMatched },
    emotions: { anger: emoRate.anger, fear: emoRate.fear, joy: emoRate.joy, sadness: emoRate.sadness },
    dominantEmotion,
    tone: { positive: emoRate.positive, negative: emoRate.negative, score: toneScore },
  };
}

// Builds a context excerpt centered on the FIRST matched dictionary word
// (not a blind first-N-characters slice), so cards show real surrounding
// context. Congressional Record floor-speech text is a US government work
// product, not subject to copyright, so quoting a verbatim window of it
// isn't a reproduction concern.
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

// Walks backward through up to DISCOURSE_LOOKBACK_DAYS of CREC packages,
// scoring every floor-speech candidate within each day and keeping only
// that day's single strongest QUALIFYING granule; a day with nothing that
// clears MIN_MATCHES is skipped entirely (not padded), until
// DISCOURSE_TARGET_COUNT entries are collected or the window runs out.
//
// GovInfo/api.data.gov accepts the shared "DEMO_KEY" with no registration
// at a low rate limit; GOVINFO_API_KEY is an optional personal-key upgrade.
async function fetchDiscourseTags() {
  const key = process.env.GOVINFO_API_KEY || "DEMO_KEY";

  const since = new Date(Date.now() - DISCOURSE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + "T00:00:00Z";
  const collectionsUrl = `https://api.govinfo.gov/collections/CREC/${since}?offsetMark=*&pageSize=${DISCOURSE_LOOKBACK_DAYS + 5}&api_key=${key}`;
  const collectionsData = await safeFetchJson(collectionsUrl);
  const packages = collectionsData?.packages ?? [];
  if (!packages.length) throw new Error("GovInfo: no recent CREC packages found");

  // Sort most-recent-first by the date embedded in packageId
  // ("CREC-YYYY-MM-DD") rather than trusting the response's own ordering.
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

      let best = null;
      for (const g of candidates) {
        try {
          const htmUrl = `https://api.govinfo.gov/packages/${packageId}/granules/${g.granuleId}/htm?api_key=${key}`;
          const html = await safeFetchText(htmUrl);
          const text = stripHtml(html);
          if (text.length < 200) continue;
          const scored = scoreText(text);
          if (!scored.dominantFoundation && !scored.dominantEmotion) continue; // below MIN_MATCHES
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

      if (!best) continue; // nothing this day cleared threshold

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

// =====================================================================
// Dormant fetchers — kept, not deleted, in case a future pass adds the
// prior-period diff each would need to earn a spot in the active
// pipelines above. Neither is called from main().
// =====================================================================

// Single-point Census ACS read; always "n/a" change with no diff fetched.
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
        change: "n/a",
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

// Single-point Census ACS read; same "n/a" limitation as fetchGini().
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

// =====================================================================
// main()
// =====================================================================

// Fetches one module's chart data, writing `outPath` with the same
// fall-back-to-last-published behavior every module uses: on success,
// merge the fetch result under the JSON's top level (or under `key`, for
// modules like Energy whose file holds more than one dataset); on
// failure, keep whatever was already published.
async function writeModuleOutput(outPath, fetchFn, { key = null } = {}) {
  const existing = await readJsonOr(outPath, {});
  const output = { generatedAt: new Date().toISOString() };
  try {
    const result = await fetchFn();
    if (key) output[key] = result;
    else Object.assign(output, result);
  } catch (err) {
    console.error(`[warn] ${fetchFn.name} failed: ${err.message}`);
    if (key) {
      if (existing[key]) output[key] = existing[key];
    } else if (existing.series) {
      Object.assign(output, existing, { generatedAt: output.generatedAt });
    }
  }
  await writeFile(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outPath}.`);
  return output;
}

async function main() {
  // ---- Core ticker ----
  const existingTicker = await loadExistingTicker();
  const indicators = [];
  for (const fn of TICKER_FETCHERS) {
    try {
      indicators.push(await fn());
    } catch (err) {
      console.error(`[warn] ${fn.name} failed: ${err.message}`);
      if (existingTicker[fn.indicatorId]) indicators.push(existingTicker[fn.indicatorId]);
    }
  }
  await writeFile(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), indicators }, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT_PATH} with ${indicators.length} indicator(s).`);

  // ---- Module chart data (each its own sibling file) ----
  await writeModuleOutput(ENERGY_OUT_PATH, fetchGenerationMix, { key: "generationMix" });
  await writeModuleOutput(GINI_OUT_PATH, fetchGiniSeries);
  await writeModuleOutput(STUDENT_LOAN_OUT_PATH, fetchStudentLoanSeries);
  await writeModuleOutput(PEACE_OUT_PATH, fetchDisplacementByRegion);

  // ---- Discourse-tagging module (its own flow: backfills short results
  // from previously-published entries instead of the generic fallback) ----
  const existingDiscourse = await readJsonOr(DISCOURSE_OUT_PATH, {});
  let discourseOutput = { generatedAt: new Date().toISOString() };
  try {
    const discourse = await fetchDiscourseTags();
    let entries = discourse.entries ?? [];
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

  await writeModuleOutput(DEMOCRACY_OUT_PATH, fetchDemocracySeries);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
