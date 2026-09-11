#!/usr/bin/env node
/**
 * Fetches ticker indicators server-side (so API keys never touch the browser)
 * and writes /ticker-data.json for the static page to read.
 *
 * Run by .github/workflows/update-ticker-data.yml on a schedule.
 *
 * Secrets expected in the repo (Settings -> Secrets and variables -> Actions):
 *   FRED_API_KEY   - https://fredaccount.stlouisfed.org/apikeys (free)
 *   BLS_API_KEY    - https://data.bls.gov/registrationEngine/ (free, optional —
 *                    script falls back to unauthenticated calls at a lower quota)
 *   CENSUS_API_KEY - https://api.census.gov/data/key_signup.html (free, optional)
 *
 * Design notes (see DECISIONS.md, Technical Requirements):
 *   - Only Tier 1 (FRED, BLS, GDELT) + the two annual indicators (WID/OWID
 *     wealth share, Census Gini) are wired up here. Tier 2 (ECB spread, OFAC
 *     additions, EU ETS/Ember) is intentionally deferred.
 *   - If a fetch fails, we keep whatever value was already in ticker-data.json
 *     for that indicator rather than crashing the whole run or writing a blank.
 *   - "GDELT tone" is NOT a true global average — the DOC 2.0 API requires a
 *     search term, so this is a broad-topic sample (gov/econ/politics
 *     coverage, English-heavy sources), labeled accordingly rather than as
 *     "Global Average Tone."
 */

import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const OUT_PATH = path.resolve(process.cwd(), "ticker-data.json");

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
    asOf: obs[0].date,
  };
}

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
    series: "ristra",
    asOf: `${black[0].year}-${black[0].period.replace("M", "")}`,
  };
}

// ---- GDELT: broad-topic tone sample (NOT a true global average) ----
async function fetchGdelt() {
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?query=government%20OR%20economy%20OR%20politics&mode=timelinetone&format=json&timespan=3d";
  const data = await safeFetchJson(url);
  const points = data.timeline?.[0]?.data ?? [];
  if (points.length < 1) throw new Error("GDELT: empty timeline");
  const latest = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : latest;
  const latestVal = Number(latest.value);
  const prevVal = Number(prev.value);
  return {
    id: "gdelt-tone",
    name: "GDELT News Tone \u2014 Gov/Econ/Politics Sample (EN-heavy sources)",
    value: latestVal.toFixed(1),
    change: fmtSigned(latestVal - prevVal, 1, ""),
    series: "ochre",
    asOf: latest.date,
  };
}

// ---- OWID (WID.world-sourced): Global Top 1% Wealth Share ----
async function fetchWealthShare() {
  const url =
    "https://ourworldindata.org/grapher/wealth-share-richest.csv?v=1&csvType=full&useColumnShortNames=false&quantile=richest_1pct";
  const csv = await safeFetchText(url, { headers: { "User-Agent": "dashboard-ticker/1.0" } });
  const lines = csv.split("\n").filter(Boolean);
  const header = lines[0].split(",");
  const entityIdx = header.indexOf("Entity");
  const yearIdx = header.indexOf("Year");
  const valueIdx = header.length - 1; // wealth-share value is the last column
  const worldRows = lines
    .slice(1)
    .map((l) => l.split(","))
    .filter((cols) => cols[entityIdx] === "World")
    .sort((a, b) => Number(b[yearIdx]) - Number(a[yearIdx]));
  if (worldRows.length < 1) throw new Error("OWID/WID: no World rows found");
  const latest = worldRows[0];
  const prev = worldRows[1] ?? latest;
  const latestPct = Number(latest[valueIdx]) * 100;
  const prevPct = Number(prev[valueIdx]) * 100;
  return {
    id: "wealth-share-top1",
    name: "Global Top 1% Wealth Share (WID.world, via OWID)",
    value: `${latestPct.toFixed(1)}%`,
    change: fmtSigned(latestPct - prevPct, 1, "pp"),
    series: "sage",
    asOf: latest[yearIdx],
    note: "Annual release \u2014 value is static between WID.world's yearly updates.",
  };
}

// ---- US Census: Gini coefficient of income inequality (ACS 1-year) ----
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

async function main() {
  const existing = await loadExisting();
  const fetchers = [fetchFred, fetchBls, fetchGdelt, fetchWealthShare, fetchGini];
  const results = [];
  for (const fn of fetchers) {
    try {
      results.push(await fn());
    } catch (err) {
      console.error(`[warn] ${fn.name} failed: ${err.message}`);
      // Fall back to whatever was already published for this indicator, if any.
      const idGuess = {
        fetchFred: "treasury-spread",
        fetchBls: "unemployment-gap",
        fetchGdelt: "gdelt-tone",
        fetchWealthShare: "wealth-share-top1",
        fetchGini: "gini-us",
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
