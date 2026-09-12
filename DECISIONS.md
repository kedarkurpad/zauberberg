# DECISIONS.md
*Working decisions for the dashboard project — first draft. See "Adding new decisions" at the bottom for how to extend this.*

---

## Theoretical Relevance

A module qualifies if it passes at least one pillar's test below. Growth, efficiency, or aggregate-welfare metrics with no power, distributional, or conflict dimension are out of scope.

1. **Structural Power & Political Economy** — Strange; Farrell & Newman; Wallerstein; Arrighi; Harvey; Streeck; Mudde; Norris & Inglehart; Petter Törnberg; Anton Törnberg.
   *Test: who holds leverage over production, finance, security, knowledge, or discourse structures?*
2. **Distributional Justice** — Piketty; Milanovic.
   *Test: who gains or loses across a distribution, not just in aggregate?*
3. **Peace and Conflict** — Galtung; Fanon; Jones (structural violence in disability/mental-health policy); Bacevich; Toft & Kushi.
   *Test: does this reveal direct/structural violence, or the blowback cost of a dominant power's policy?*
4. **Energy** — Klein; Riofrancos; Malm; Mitchell.
   *Test: does this show energy infrastructure, extraction, or transition politics as contested power, not just supply-and-demand economics?*

## Style

Visual direction: a refined, decluttered evolution of the Bloomberg Terminal aesthetic — dark-mode, data-forward, high information density without visual noise.

**Palette** — WCAG 2.1 AA-checked, with a nod to New Mexico/Southwestern tones. Terracotta/turquoise take the terminal's usual orange/cyan roles; ristra red and ochre round it out.

| Color | Hex | Role | Contrast vs. background |
|---|---|---|---|
| Background | `#14110D` | page | — |
| Panel | `#211C17` | surface | — |
| Border / grid | `#6E6255` | UI borders, gridlines | 3.2:1 (non-text min) |
| Text primary | `#F0E6D8` | body text | 15.3:1 |
| Terracotta | `#E2643B` | primary data series | 5.5:1 |
| Turquoise | `#2DB6A6` | secondary series | 7.5:1 |
| Ochre | `#D9A441` | highlights | 8.4:1 |
| Ristra red | `#D25858` | links / quaternary series | 4.7:1 |
| Sage | `#8FA876` | positive / alt series | 7.2:1 |

**Value-polarity exception on the ticker (added 2026-09-11):** by default, a ticker delta is colored by its indicator's assigned series/pillar token, not by whether the move is "good" or "bad" \u2014 up/down isn't uniformly positive or negative across most indicators (e.g. the Treasury spread, the dollar index). Three indicators are a deliberate exception, carrying an explicit `polarity` field because this project's own distributive-justice framing (Piketty; Milanovic) treats their direction as normatively loaded: `labor-share` (`good-up` \u2014 rising labor share reads as good) and `wealth-share-top1` / `income-share-top1-us` (`bad-up` \u2014 rising top-1% concentration reads as bad). Their deltas render turquoise (good) or ochre (bad), **universally, regardless of which pillar the indicator otherwise belongs to** \u2014 updated same day from an earlier sage/ristra version. Tradeoff: ochre is also `spr-level`'s plain Pillar-4 identity color, so a neutral SPR move and a "bad" judgment on either top-1%-share indicator render in the identical ochre for unrelated reasons \u2014 accepted, not an oversight. Turquoise has no such collision today (unclaimed by any live, non-polarity indicator). No other indicator should get a `polarity` field without equally clear, stated normative grounding; most of this project's metrics (yield spreads, currency indices, reserve levels) don't have one.

**Energy module color-token exception (added 2026-09-11):** the two charts inside the Energy (Pillar 4) panel — generation-mix stacked area and crude-import treemap — use the full 5-token palette as a plain categorical set (one color per series/country), not per-pillar identity, since a single ochre token can't distinguish 3–8 series. Scoped to charts internal to this one module panel only; the ticker's existing one-token-per-pillar rule (and its known ochre collision between `spr-level` and the two `bad-up` polarity indicators) is unchanged elsewhere.

**Placeholder panel titles (added 2026-09-11):** by request, the four pillar panel headings were changed from full names to plain numerals (1–4). This is visual-only — the original names are preserved via `aria-label` on each heading so screen-reader users still get the pillar name, not a bare number. Revisit once real panel content ships and the numeral-only heading may need to come back or be paired with a visible label.

## Accessibility

- Baseline: WCAG 2.1 AA (4.5:1 contrast for body text, 3:1 for large text/UI components).
- Typefaces are system-font stacks only (no Google Fonts or other externally hosted faces), for cross-platform rendering and low-network reliability; tradeoff is losing the more distinctive custom pairing (previously Space Grotesk / IBM Plex Mono) in favor of default OS faces.

## Technical Requirements

- Computational social science / NLP methods (sentiment and discourse analysis on social media data) are part of the toolkit, applied to drivers of far-right and ethnonationalist political outcomes — theory anchored in Pillar 1 above (Mudde; Norris & Inglehart; Petter & Anton Törnberg). Likely output form: sentiment time-series by electoral cycle and/or discourse-community network graphs, not single aggregate scores.
- **Hosting: GitHub Pages** (static only — no server, no client-side secrets).
- **Data pipeline architecture: scheduled GitHub Action → static JSON, not live client-side polling.** A cron-scheduled GH Action fetches each source server-side (API keys live in repo secrets), computes the display value, and commits a `ticker-data.json`; the page fetches that JSON at load. Chosen over direct browser-to-API calls because several sources require a key that can't be exposed client-side in a public repo (FRED, BLS) and/or block cross-origin requests. Tradeoff: data is only as fresh as the last Action run, not truly real-time.
- **Ticker indicator tiering, by lift/access/refresh cadence:**
  - *Tier 1 (build first):* FRED T10Y2Y (free key, daily), BLS Black–White unemployment gap (free key, monthly), GDELT global tone (keyless DOC 2.0 `timelinetone` endpoint).
  - *Tier 2:* ECB SDW BTP–Bund spread (keyless SDMX, daily, two-series parse); OFAC SDN additions (public CSV, but "rolling 90-day additions" requires diffing snapshots collected going forward — undercounts for the first ~90 days after launch, cold-start tradeoff); EU ETS carbon price sourced from Ember Climate's open API rather than ICE Endex, since ICE Endex data is licensed/paid — changes the footer's stated source for that indicator.
  - *Kept as topline indicators despite annual-only refresh:* Global Top 1% Wealth Share (WID.world) and US Gini Coefficient (Census Bureau/ACS). Both have real, freely-accessible APIs; they just update once a year, so their ticker value will sit static between releases — accepted tradeoff to keep long-run distributional-inequality signal visible on the ticker.
  - *Dropped from v1 (no viable low-lift API found):* Cornell/Illinois Labor Action Tracker (data lives only in an interactive map, no public API); ACLED conflict count (now gated behind org-level registration and OAuth-token tiers, with redistribution restrictions — heavier lift than fits "lightest lift").
  - *Dropped by request:* GDELT tone sample. It worked in principle (keyless DOC 2.0 API) but proved unreliable from GitHub's runners (persistent network-level failures even after retries and UA-header fixes), and — independent of that reliability issue — the project would rather give its own NLP/sentiment-analysis panels (see the computational-social-science bullet above) more visual prominence than a borrowed proxy tone metric on the ticker.
  - *Added, reusing already-established APIs/secrets (no new plumbing):* Labor Share of GDP (FRED, Penn World Table series, annual — chosen over a BLS quarterly index alternative whose units weren't unambiguously a % share); White\u2013Black Median Household Income Gap (Census ACS, same pattern as the existing Gini fetch, same secret); US Top 1% Income Share, Before Tax (OWID/WID, same CSV-parsing code as the existing global wealth-share indicator, generalized to take a chart slug + entity name). All three logged as Pillar 1/2 fits (structural power over production and income, distributional justice).
  - *Added 2026-09-11 (forex, no new secret):* Nominal Broad U.S. Dollar Index (FRED, `DTWEXBGS`, daily) as a Pillar 1 indicator — trade-weighted dollar strength as a proxy for currency/finance structural power (Strange; also the dollar-clearing infrastructure Farrell & Newman's "weaponized interdependence" concerns), not a bare FX quote. Reuses the existing `FRED_API_KEY`.
  - *Added 2026-09-11 (energy, new secret):* Strategic Petroleum Reserve crude oil ending stocks (EIA, series `PET.WCSSTUS1.W`, weekly) as a Pillar 4 indicator — a held strategic reserve is energy security as state leverage (Mitchell, *Carbon Democracy*), not a bare commodity price, so it clears the Pillar 4 relevance test that a raw oil/gas spot price would not. Requires a new `EIA_API_KEY` secret (free registration; EIA has no unauthenticated fallback the way BLS/Census do). Visual token: ochre, shared with the still-unbuilt EU ETS carbon-price indicator under the one-token-per-pillar rule (both Pillar 4).
  - *Data-staleness finding (2026-09-11):* `labor-share`'s client-side fallback value was a made-up placeholder (62.8%/+0.1pp) that didn't match reality — verified directly against FRED that the real latest observation is 2023 at 56.83% (down from 57.62% in 2022), corrected to 56.8%/-0.8pp. More importantly, FRED lists this series' Next Release Date as **Not Available**, meaning Penn World Table 11.0 may never get another scheduled update — a materially bigger staleness risk than the "refreshes annually" framing used elsewhere for annual indicators. If the live fetch keeps returning 2023 indefinitely, that's the source being stuck, not a bug. Separately confirmed the OWID/WID top-1%-share dataset (`wealth-share-top1`, `income-share-top1-us`) runs through 2024 with a next-expected-update of June 2027 — meaningfully fresher than labor-share, though the exact current point values for the "World" and "United States" entities weren't individually verified (would require a full-dataset fetch); those two indicators' fallback numbers remain illustrative placeholders pending a real fetch run.

---

## Energy module visualizations (Pillar 4)

- **Relevance framing:** a plain "energy mix" chart reads as supply-and-demand economics, which Pillar 4's test excludes. Both charts below are framed instead around contested power: transition politics for the generation mix (Malm; Riofrancos; Mitchell) and import dependency as structural leverage for crude imports (Strange; Mitchell) — same reasoning already used for the ticker's SPR indicator.
- **Generation mix** (stacked area, fossil/nuclear/renewables share over time): sourced from EIA `electricity/electric-power-operational-data` or `total-energy`. Not yet wired to a live fetch — ships with clearly-labeled illustrative placeholder values (2016–2026, hand-set) pending that work, following the same "labeled synthetic data" convention as the footer's discourse-tagging samples.
- **Crude oil imports by country of origin** (treemap): sourced from EIA `petroleum/move/impcus/data`. Same placeholder-data caveat as above. Chosen over a generic "top suppliers" bar chart because the point is relative exposure/concentration, which a treemap's area encoding shows more directly than a ranked list.
- **Live-wiring path, when picked up:** extend the existing scheduled-GitHub-Action → static-JSON pattern (see Technical Requirements) with `fetchGenerationMix()` and `fetchCrudeImports()` in `fetch-ticker-data.mjs` (or a sibling script/JSON file, if these shouldn't share a commit cadence with the ticker) — same reasons as the ticker: FRED/BLS-style key exposure and CORS apply equally to EIA.

## Adding new decisions

When a new decision is agreed on, add it under the matching category above as a short bullet (1–2 sentences; note the tradeoff if there is one). If it doesn't fit an existing category, add a new `##` section. Log it below with a date so changes stay traceable without cluttering the categories themselves.

## Changelog

- 2026-09-11 (time not recorded) — Initial draft: pillars, style/palette, accessibility, technical requirements established.
- 2026-09-11 13:32 EDT — Switched to system-font stacks (no externally hosted typefaces) for cross-platform readability and low-network reliability; logged under Accessibility.
- 2026-09-11 (later) — Settled the "still open" hosting/pipeline/dataset items: GitHub Pages + scheduled GitHub Action writing a static `ticker-data.json`; ticker indicators tiered by API access and refresh cadence (Tier 1: FRED, BLS, GDELT); WID.world wealth share and Census Gini kept as topline indicators despite annual-only refresh, by request; Labor Action Tracker and ACLED dropped from v1 for lack of a low-lift API path; EU ETS indicator re-sourced from Ember Climate (ICE Endex is paid/licensed) — logged under Technical Requirements.
- 2026-09-11 (later still) — Dropped GDELT tone from the ticker: unreliable from the GitHub Actions runner (network-level failures survived retries and a browser User-Agent fix) and, separately, project preference to give the site's own NLP/sentiment-analysis panels more visual weight than a borrowed proxy metric — logged under Technical Requirements.
- 2026-09-11 (even later) — Added three more ticker indicators by reusing already-established API access (no new secrets/plumbing): FRED labor share of GDP, Census White\u2013Black household income gap, and OWID/WID US top 1% income share — logged under Technical Requirements.
- 2026-09-11 (later yet) — Renamed Pillar 3 heading from "Peace, Conflict & Anti-Hegemony" to "Peace and Conflict"; theorists and the blowback-cost test are unchanged, so anti-hegemony literature (Bacevich; Toft & Kushi) remains in scope under the shorter name.
- 2026-09-11 (later still) — Added two new core-ticker indicators: Nominal Broad U.S. Dollar Index (FRED `DTWEXBGS`, daily, Pillar 1 — currency/finance structural power, no new secret) and Strategic Petroleum Reserve crude oil stocks (EIA `PET.WCSSTUS1.W`, weekly, Pillar 4 — energy security as state leverage, requires a new `EIA_API_KEY` secret) — logged under Technical Requirements. SPR takes the ochre token, which it will share with the still-unbuilt EU ETS carbon-price indicator once that ships (both Pillar 4, consistent with the one-token-per-pillar rule).
- 2026-09-11 (even later still) — Introduced a value-polarity exception to the "delta color = pillar identity, not a judgment" rule: `labor-share` now renders `good-up` (green on increase), and `wealth-share-top1` / `income-share-top1-us` render `bad-up` (red on increase), reflecting this project's own Piketty/Milanovic distributive-justice framing. Logged under Style, including the tradeoff that this reopens the ristra/link-color overlap on the two `bad-up` indicators.
- 2026-09-11 (later, same day) — Universalized the polarity colors to turquoise (good) / ochre (bad) regardless of pillar, replacing the earlier sage/ristra version — resolves the ristra/link collision, but opens a new one: ochre is also `spr-level`'s Pillar-4 identity color. Also corrected `labor-share`'s fallback value from a made-up 62.8% to the real FRED figure (56.8%, 2023) and flagged that Penn World Table 11.0 has no scheduled next release — both logged under Style and Technical Requirements respectively.
- 2026-09-11 (later still) — Renamed the four pillar panel headings from full names to plain numerals (1–4) by request; original names kept via `aria-label` for screen readers. Logged under Style.
- 2026-09-11 (later still) — Built the Energy module's first two visualizations: a generation-mix stacked area chart (fossil/nuclear/renewables) and a crude-oil-imports-by-country-of-origin treemap, both reframed around contested power rather than raw supply/demand per the Pillar 4 test, both currently illustrative placeholder data pending live EIA wiring. Introduced a scoped color-token exception so these two internal charts can use the full 5-token palette categorically instead of one Pillar-4 token. Logged under a new "Energy module visualizations" section and under Style.
