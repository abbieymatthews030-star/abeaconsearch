# 🔦 Beacon Search

A small, **fully open-source, self-hostable full-text search engine** with a web UI.
No database, no external services — the index lives in memory and is persisted to a
single JSON file. Runs anywhere Node.js 20+ runs, or as a Docker container.

- **Full-text search** with prefix + fuzzy matching, title/tag boosting, tag facets and highlighted snippets (powered by [MiniSearch](https://github.com/lucaong/minisearch)).
- **UK number plate checker** with automatic backend checks — format, age identifier, DVLA region, and (with free API keys) DVLA tax/MOT status and DVSA MOT history.
- **MCP server** (`beacon-mcp`, built on [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)) exposing the plate checker and the index as tools for Claude & other MCP clients.
- **REST API** built on [Fastify](https://fastify.dev/) with schema validation.
- **Web UI** (React + Vite) for searching, plate checks, adding documents and crawling sites.
- **Built-in crawler** that indexes a website's pages and respects `robots.txt`.
- **CLI** (`beacon`) for scripting: add, import, crawl, search, stats, plate.
- **Zero-config**: every setting has a sane default. Point it at content and go.

---

## Quick start

### With Node.js

```bash
git clone https://github.com/abbieymatthews030-star/abeaconsearch.git
cd abeaconsearch
npm install
npm run build
npm start
# → http://localhost:7700
```

### With Docker

```bash
docker compose up --build
# → http://localhost:7700   (index persisted in the `beacon-data` volume)
```

or plain Docker:

```bash
docker build -t abeaconsearch .
docker run -p 7700:7700 -v beacon-data:/data abeaconsearch
```

### Development (API + UI with hot reload)

```bash
npm install
npm run dev
# API on :7700, Vite dev server on :5173 (proxies /api to :7700)
```

---

## Production deployment (own server + domain)

[`deploy/`](deploy) has a single-host setup: **Caddy** in front of Beacon with
automatic, auto-renewing Let's Encrypt TLS, hardened containers, HTTP basic auth
on the write endpoints, and a nightly backup script.

```bash
cd deploy
cp beacon.env.example beacon.env      # set BEACON_DOMAIN, ACME email, auth hash
docker compose -f docker-compose.prod.yml up -d --build
```

Full walkthrough — server prep, DNS, firewall, backups, updates, the no-Docker
(systemd) path — in **[docs/deploy.md](docs/deploy.md)**.

---

## Adding content

**Crawl a website** (from the UI's _Crawl site_ tab, or):

```bash
npm run cli -- crawl https://example.com --max-pages 100
```

**Import a JSON file** (array of documents, or `{ "documents": [...] }`):

```bash
npm run cli -- import examples/documents.sample.json
```

**Add one document via the API:**

```bash
curl -X POST http://localhost:7700/api/documents \
  -H 'content-type: application/json' \
  -d '{"title":"Hello","body":"world","tags":["demo"]}'
```

After building and installing globally (`npm link` or `npm i -g .`) the CLI is
available as `beacon`.

---

## HTTP API

| Method   | Path                  | Description                                          |
| -------- | --------------------- | ---------------------------------------------------- |
| `GET`    | `/api/health`         | Liveness + document count                            |
| `GET`    | `/api/stats`          | Index statistics, top tags/sources                   |
| `GET`    | `/api/search`         | `?q=&limit=&offset=&tags=&source=&fuzzy=&prefix=`    |
| `GET`    | `/api/documents`      | List documents (`?limit=&offset=`)                   |
| `GET`    | `/api/documents/:id`  | Fetch one document                                   |
| `POST`   | `/api/documents`      | Create/replace a document                            |
| `PUT`    | `/api/documents/:id`  | Replace a document by id                             |
| `DELETE` | `/api/documents/:id`  | Delete a document                                    |
| `POST`   | `/api/documents/bulk` | `{ "documents": [...] }`                             |
| `POST`   | `/api/crawl`          | `{ "url", "maxPages?", "sameOriginOnly?", "tags?" }` |
| `POST`   | `/api/index/clear`    | Remove all documents                                 |
| `GET`    | `/api/plate/:reg`     | Check a number plate (`?vehicle=&mot=&index=`)       |
| `POST`   | `/api/plate/check`    | `{ "plate", "vehicle?", "mot?", "index?" }`          |

### Search response

```jsonc
{
  "query": "fastify",
  "total": 1,
  "limit": 10,
  "offset": 0,
  "tookMs": 0.42,
  "hits": [
    {
      "id": "fastify-guide",
      "score": 3.14,
      "title": "<mark>Fastify</mark> guide",
      "url": "https://…",
      "tags": ["web"],
      "source": "handbook",
      "snippet": "… build APIs with <mark>Fastify</mark> …",
      "terms": ["fastify"],
    },
  ],
  "facets": { "tags": { "web": 1 }, "sources": { "handbook": 1 } },
}
```

---

## Number plate checker

Runs a series of automatic checks on a UK vehicle registration mark and returns a
structured report (each check is `pass` / `warn` / `fail` / `info` / `skipped`):

| Check                                                              | Source                                                                                              | Needs               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------- |
| Format & character set                                             | offline                                                                                             | —                   |
| Age identifier → registration date range                           | offline                                                                                             | —                   |
| Region / former DVLA office (memory tag)                           | offline                                                                                             | —                   |
| Make, colour, year, fuel, **tax status**, **MOT status**           | [DVLA Vehicle Enquiry Service](https://register-for-vehicle-enquiry-service.service.gov.uk/) (free) | `DVLA_VES_API_KEY`  |
| Manufacture-year vs plate-age consistency, export marker           | DVLA VES                                                                                            | `DVLA_VES_API_KEY`  |
| Full MOT history, pass/fail counts, **odometer anomaly** detection | [DVSA MOT History API](https://documentation.history.mot.api.gov.uk/) (free)                        | `MOT_*` credentials |

With no credentials the offline checks still run. Configure keys in `.env` — see
[`.env.example`](.env.example).

```bash
beacon plate "AB12 CDE"                     # human-readable report
beacon plate "AB12 CDE" --json --index      # JSON, and store the report in the index
curl 'http://localhost:7700/api/plate/AB12CDE?vehicle=false&mot=false'
```

Set `BEACON_PLATE_INDEX_RESULTS=true` (or pass `index=true`) to save every check
into the search index as a `plate-check` document — so past checks are searchable.

---

## MCP server

`beacon-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server
(stdio) exposing the plate checker and the search index as tools. Full details in
[docs/mcp.md](docs/mcp.md).

```bash
npm run build
claude mcp add beacon-search -- node dist/mcp/index.js   # Claude Code
```

Tools: `check_number_plate`, `validate_plate_format`, `decode_plate`,
`dvla_vehicle_enquiry`, `mot_history`, `beacon_search`, `beacon_index_document`,
`beacon_stats`. A project-scoped [`.mcp.json`](.mcp.json) is included.

---

## Configuration

All configuration is via environment variables (or a `.env` file — auto-loaded).
See [`.env.example`](.env.example) for the full list. Common ones:

| Variable                 | Default             | Description                      |
| ------------------------ | ------------------- | -------------------------------- |
| `BEACON_PORT`            | `7700`              | HTTP port (`PORT` also honoured) |
| `BEACON_HOST`            | `0.0.0.0`           | Bind address                     |
| `BEACON_DATA_DIR`        | `data`              | Where the index file is stored   |
| `BEACON_INDEX_FILE`      | `<data>/index.json` | Explicit index path              |
| `BEACON_WEB_DIR`         | `web/dist`          | Built web UI directory           |
| `BEACON_CORS_ORIGIN`     | _(all)_             | Comma-separated allowed origins  |
| `BEACON_LOG_LEVEL`       | `info`              | `trace`…`error`, or `silent`     |
| `BEACON_CRAWL_MAX_PAGES` | `50`                | Default crawl page budget        |

---

## How it works

```
             ┌──────────────┐      ┌─────────────────────┐
  HTTP  ───► │  Fastify API │ ───► │   SearchEngine      │
  CLI   ───► │  + web UI    │      │   (MiniSearch)      │
  Crawler ─► └──────────────┘      └─────────┬───────────┘
                                             │ debounced, atomic
                                             ▼
                                    data/index.json  (snapshot)
```

The engine holds every document in memory and mirrors it into a MiniSearch
index. Mutations schedule a debounced, atomic write (`write temp → rename`) of a
versioned JSON snapshot. On startup the snapshot is read back and the index
rebuilt, which keeps the on-disk format stable across dependency upgrades.

---

## Project layout

```
src/core/        search engine, persistence, crawler, robots, config  (no HTTP)
src/core/plate/  number plate format/age/region logic + DVLA/DVSA providers
src/server/      Fastify app, routes, entrypoint
src/cli/         `beacon` command
src/mcp/         `beacon-mcp` Model Context Protocol server
web/             React + Vite single-page UI
```

## Scripts

| Script                 | Purpose                                             |
| ---------------------- | --------------------------------------------------- |
| `npm run dev`          | API + UI with hot reload                            |
| `npm run build`        | Compile server + MCP (`dist/`) and UI (`web/dist/`) |
| `npm start`            | Run the compiled server                             |
| `npm run start:mcp`    | Run the compiled MCP server                         |
| `npm test`             | Run the Vitest suite                                |
| `npm run lint`         | ESLint                                              |
| `npm run typecheck`    | `tsc --noEmit`                                      |
| `npm run cli -- <cmd>` | Run the CLI from source                             |
| `npm run mcp`          | Run the MCP server from source                      |

## License

[MIT](LICENSE)
