# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Deep search mode:** `?mode=deep` / `?deep=1` on `/api/query` (and a Deep
  toggle in the UI) fans out to long-tail keyless providers — Wayback Machine
  CDX, Common Crawl index, Hacker News (Algolia), Reddit JSON, and Marginalia
  (shared `public` API key, or `MARGINALIA_API_KEY`). Each provider has a
  timeout, appears in Settings → Sources, and can be toggled off. Deep mode
  uses `BEACON_DEEP_SEARCH_BUDGET_MS` (default 6s).
- **Indie-aware rerank + source types:** Merged hits are rescored so small /
  independent domains, official / academic / archive sources and older pages
  rise above SEO megasites. Each result carries `sourceType` and
  `rankReasons`; the UI filters by type via `?sourceType=`.
- **Never-empty failures:** When every provider fails (or nothing matches),
  the envelope includes `rewrites` and names failed providers so the UI can
  offer concrete next steps instead of a blank page.
- **Settings customisation:** General prefs for colour theme (system / light /
  dark), text size, content width, spacious density, reduce motion, and
  toggles for snippets, result meta, tags, and search suggestions. Choices
  stay in `localStorage` until changed or restored.

### Changed

- **Answers flag disagreements:** When grounded claims from different sources
  conflict, both sides stay cited and a search-gap note explains that Beacon
  does not pick a winner.
- **Private Docker Compose** sets `BEACON_KEYLESS_WEB_SEARCH=0` by default
  (enable in `.env` when you want keyless live web search on the private
  stack).
- **Faster live search:** `/api/query` no longer waits for every web backend.
  A shared search budget (`BEACON_SEARCH_BUDGET_MS`, default 2.5s) aborts slow
  providers; everyday queries use a fast tier (Brave / Tavily / SearXNG /
  DuckDuckGo / Wikipedia) first and only call scholarly / archive sources when
  the query looks research-shaped or the fast tier is empty. DuckDuckGo races
  HTML + JSON; pinned answer sources fetch in parallel; domain/IP/calc primary
  cards overlap the web fan-out.
- **Home UI polish:** empty Search tab is a single brand-first composition
  (beacon mark, product name, one line, search CTA). Compact chrome returns
  once you query. IBM Plex Mono + warmer paper/grid atmosphere.
- **Always-answer policy:** `/api/answer` answers every topic from retrieved
  sources or, when sources are thin/missing, from an LLM knowledge fallback.
  Soft model refusals are retried. The only denials are bestiality and sexual
  or physical violence against women (`denied: true`). The web UI now shows
  knowledge-fallback and deny-list answers instead of hiding `confidence: none`
  prose.

### Added

- **Full website + custom domain packaging:** product site chrome (About /
  Privacy, brand home, hero landing, SEO meta / robots / manifest),
  `BEACON_SITE_URL` / `BEACON_SITE_NAME`, public Compose overlay
  (`docker-compose.public.yml` + `deploy/Caddyfile.public`) that serves your
  domain over HTTPS without basic auth while blocking admin write routes, and
  [`docs/website.md`](docs/website.md) for DNS + deploy without a PaaS.
- **Tor mode:** header Tor toggle (UI ~50% purple / 25% white / 25% black) that
  searches onion services via Ahmia + a curated Tor directory, and opens
  `.onion` links through Beacon’s SOCKS5h proxy (`GET /api/tor/browse`,
  `GET /api/tor/status`, `?tor=true` on `/api/query`). Docker Compose ships a
  `tor` sidecar (`dperson/torproxy`) so users do not need Tor Browser.
- **Deep keyless web sources** for search result lists and answer retrieval:
  OpenAlex, Crossref, arXiv, Europe PMC, Wikidata, Internet Archive, Open
  Library, DOAJ, Library of Congress, and Project Gutenberg (Gutendex). They
  fan out with DuckDuckGo / Wikipedia whenever `BEACON_KEYLESS_WEB_SEARCH` is
  on — no API keys required. Trust tiers treat the new scholarly / archive
  domains as `established`.

### Fixed

- **Trust / reuse polish (50 items):** plate headlines no longer claim “all checks
  passed” when DVLA/MOT were skipped; theft/finance guidance moved to `notices`;
  `checkedAt` is wall-clock with optional `referenceDate`; unsupported answer
  sentences are marked `(unverified)` and high confidence requires a live fetch;
  corrupt index files refuse to load; dropped docs and persist failures are
  surfaced; document mutations flush immediately; answer cache clears on index
  change; all-failed web search returns `outcome: "error"`; health/diagnostics
  report `degraded`; answer busy is `503 busy` (not rate-limit); rate-limit JSON
  is shaped consistently; robots fail-open is warned in crawl/CLI; highlights use
  word boundaries; did-you-mean rewrites multi-word queries; stats expose only
  the index basename; settings PATCH fails when any field errors; timeouts say
  timed out; domain AAAA/MX gaps are noticed; `web=true` forces web search; MCP
  blank search sorts newest; README naming + API table completed.
- **Web UI polish:** safer API error parsing, favicon, hash tabs, brand
  consistency, confirms for destructive clears/resets, crawl/add success stays
  visible, stale results dim while loading, answer copy + smooth citations,
  real answer errors, a11y focus/`aria-*`, history validation and immediate
  re-run, locale counts/dates, domain/IP empty states, honest local-index
  health, settings save errors, required document body, and reduced-motion
  transitions.

### Added

- **Answer weave** (`src/core/answer/`): `GET /api/answer?q=` and the Search tab
  return a short written answer for question-like queries, assembled only from
  retrieved sources. Retrieval combines the local index with optional live web
  search (`brave` / `tavily` / `searxng`), fetching each result through the
  crawler's `robots.txt` / SSRF-guard / timeout stack. Grounded sentences are
  woven into prose by an optional LLM (`ANTHROPIC_API_KEY`, or any
  OpenAI-compatible endpoint) and fall back to a deterministic weave otherwise.
  Every sentence is citation-checked; each source carries a trust tier, a
  retrieval timestamp and a reason, and an overall confidence banner is
  computed. See `docs/answers.md`. All configuration is optional.
- `src/core/readable.ts`: `fetchHtml` + `extractReadable`, the HTML-to-text
  helpers extracted from the crawler and now shared with answer retrieval.
- `SearchEngine.search` accepts an optional `{ combineWith: 'AND' | 'OR' }`.

- **UK number plate checker** (`src/core/plate/`): offline format classification
  (current / prefix / suffix / Northern Ireland / dateless), age-identifier
  decoding to a registration date range, and DVLA memory-tag → region/office
  lookup. Optional providers for the DVLA Vehicle Enquiry Service (tax & MOT
  status, vehicle details) and the DVSA MOT History API (full history, mileage
  anomaly detection). Exposed as `GET /api/plate/:reg`, `POST /api/plate/check`,
  the `beacon plate` CLI command, and a "Plate check" tab in the web UI.
- Plate checks can be indexed as searchable `plate-check` documents
  (`BEACON_PLATE_INDEX_RESULTS` or `?index=true`).
- **`beacon-mcp`** — a Model Context Protocol server (`@modelcontextprotocol/sdk`,
  stdio) exposing `check_number_plate`, `validate_plate_format`, `decode_plate`,
  `dvla_vehicle_enquiry`, `mot_history`, plus `beacon_search` /
  `beacon_index_document` / `beacon_stats` (which proxy a running HTTP API).
  Project-scoped `.mcp.json` and `docs/mcp.md` included.

### Changed

- The web UI now imports its API response types (`SearchResponse`, `IndexStats`,
  `BeaconDocument`, `PlateCheck`) directly from the backend via a `@core/*` path
  alias, instead of maintaining hand-copied duplicates that could drift. These
  are type-only imports, erased at build time — the bundle is byte-identical.
- Consistency pass (no behaviour change): `/health` and `/api/health` now return
  the same body; HTTP 404s always use `error: "not_found"`; one `fetchWithTimeout`
  helper backs every outbound request; one `slugify` backs ids and tags; the MCP
  server reuses the checker's provider instances (single MOT token cache); the
  DVLA/DVSA request timeout is configurable via `BEACON_PLATE_TIMEOUT_MS`; plate
  provider env vars also accept a `BEACON_` prefix; `readString` trims;
  `loadConfig` merges a partial `plate` override instead of replacing it.

### Fixed

- Boolean query-string params (`?fuzzy=`, `?prefix=`, `?vehicle=`, `?mot=`,
  `?index=`) were parsed with `z.coerce.boolean()`, so `?fuzzy=false` evaluated
  to `true`. Replaced with a param-aware coercion.
- Prefix-era age decoding placed T–Y registrations up to two years too late
  (e.g. a Y-reg shown as 2003); replaced the arithmetic with an explicit
  DVLA period table for both the prefix and suffix eras.
- `PlateCheck.summary.status` now distinguishes `invalid` (malformed mark) from
  `fail` (valid mark, a check failed) — an untaxed car with a valid plate is no
  longer reported as "invalid".
- MOT history: derive the current certificate expiry from the latest passed
  test (the trade API has no vehicle-level expiry field), so an expired MOT is
  actually flagged. Added a timeout to the OAuth token request.
- `PlateChecker.check` no longer throws on an unparseable `referenceDate`, and
  always emits a `dvla-record` / `mot-history` check line (skipped, with a
  reason) instead of silently omitting it.

## [1.0.0] - 2026-09-01

### Added

- In-memory full-text search engine (MiniSearch) with prefix/fuzzy matching,
  title and tag boosting, tag/source facets and highlighted snippets.
- Atomic, debounced JSON snapshot persistence with a versioned on-disk format.
- Fastify REST API: search, document CRUD, bulk import, stats, health, index
  clear, and website crawl.
- Built-in breadth-first web crawler with `robots.txt` support and configurable
  concurrency, delay and page budget.
- React + Vite single-page web UI: search with facets and pagination, add
  document form, crawl form, index status.
- `beacon` CLI: `serve`, `add`, `import`, `crawl`, `search`, `stats`.
- Zero-config environment-variable configuration with `.env` auto-loading.
- Multi-stage Dockerfile (non-root, health check) and `docker-compose.yml`.
- GitHub Actions CI: lint, typecheck, test, build, server + Docker smoke tests
  on Node 20 and 22.
