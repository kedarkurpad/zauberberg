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
 *   - Wired up: FRED (T10Y2Y, labor share), BLS (unemployment gap), Census
 *     (Gini, White-Black income gap), OWID/WID (global top 1% wealth share,
 *     US top 1% income share). GDELT tone was dropped by request — see
 *     DECISIONS.md changelog. Tier 2 (ECB spread, OFAC additions, EU
 *     ETS/Ember) is intentionally deferred.
 *   - If a fetch fails, we keep whatever value was already in ticker-data.json
 *     for that indicator rather than crashing the whole run or writing a blank.
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
    asOf: obs[0].date,
    note: "Annual release \u2014 value is static between updates.",
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
  return {
    latestPct: parseFloat(latest[valueIdx]) * 100,
    prevPct: parseFloat(prev[valueIdx]) * 100,
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
    series: "turquoise",
    asOf: year,
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

// ---- US Census: White-Black median household income gap (ACS 1-year) ----
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
  const fetchers = [fetchFred, fetchLaborShare, fetchBls, fetchIncomeGap, fetchWealthShare, fetchIncomeShareUS, fetchGini];
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
        fetchBls: "unemployment-gap",
        fetchIncomeGap: "income-gap-us",
        fetchWealthShare: "wealth-share-top1",
        fetchIncomeShareUS: "income-share-top1-us",
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
