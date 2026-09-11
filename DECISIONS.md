# DECISIONS.md
*Working decisions for the dashboard project — first draft. See "Adding new decisions" at the bottom for how to extend this.*

---

## Theoretical Relevance

A module qualifies if it passes at least one pillar's test below. Growth, efficiency, or aggregate-welfare metrics with no power, distributional, or conflict dimension are out of scope.

1. **Structural Power & Political Economy** — Strange; Farrell & Newman; Wallerstein; Arrighi; Harvey; Streeck; Mudde; Norris & Inglehart; Petter Törnberg; Anton Törnberg.
   *Test: who holds leverage over production, finance, security, knowledge, or discourse structures?*
2. **Distributional Justice** — Piketty; Milanovic.
   *Test: who gains or loses across a distribution, not just in aggregate?*
3. **Peace, Conflict & Anti-Hegemony** — Galtung; Fanon; Jones (structural violence in disability/mental-health policy); Bacevich; Toft & Kushi.
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

---

## Adding new decisions

When a new decision is agreed on, add it under the matching category above as a short bullet (1–2 sentences; note the tradeoff if there is one). If it doesn't fit an existing category, add a new `##` section. Log it below with a date so changes stay traceable without cluttering the categories themselves.

## Changelog

- 2026-09-11 (time not recorded) — Initial draft: pillars, style/palette, accessibility, technical requirements established.
- 2026-09-11 13:32 EDT — Switched to system-font stacks (no externally hosted typefaces) for cross-platform readability and low-network reliability; logged under Accessibility.
- 2026-09-11 (later) — Settled the "still open" hosting/pipeline/dataset items: GitHub Pages + scheduled GitHub Action writing a static `ticker-data.json`; ticker indicators tiered by API access and refresh cadence (Tier 1: FRED, BLS, GDELT); WID.world wealth share and Census Gini kept as topline indicators despite annual-only refresh, by request; Labor Action Tracker and ACLED dropped from v1 for lack of a low-lift API path; EU ETS indicator re-sourced from Ember Climate (ICE Endex is paid/licensed) — logged under Technical Requirements.
- 2026-09-11 (later still) — Dropped GDELT tone from the ticker: unreliable from the GitHub Actions runner (network-level failures survived retries and a browser User-Agent fix) and, separately, project preference to give the site's own NLP/sentiment-analysis panels more visual weight than a borrowed proxy metric — logged under Technical Requirements.
- 2026-09-11 (even later) — Added three more ticker indicators by reusing already-established API access (no new secrets/plumbing): FRED labor share of GDP, Census White\u2013Black household income gap, and OWID/WID US top 1% income share — logged under Technical Requirements.
