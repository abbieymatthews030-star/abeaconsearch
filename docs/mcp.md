# Beacon MCP server

`beacon-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server
(built on the open-source `@modelcontextprotocol/sdk`) that exposes the number-plate
checker and the search index as tools for Claude and other MCP clients.

It speaks MCP over **stdio**. The plate tools run in-process; the `beacon_*` tools
call a running Beacon Search HTTP API (so they share one index file with no
concurrent-writer races).

## Tools

| Tool                    | What it does                                                                                                                                                                                                                       | Needs                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `check_number_plate`    | Full automatic report for a UK **or Australian** plate (country auto-detected, or pass `country: "GB" \| "AU"`): format, and for UK also age/region + optional DVLA/DVSA data; for AU, shape validation + candidate issuing states | — (more with API keys, UK only)                                         |
| `validate_plate_format` | Structural validity of a UK or Australian registration mark                                                                                                                                                                        | —                                                                       |
| `decode_plate`          | UK: age period + DVLA region/office, offline. AU: shape + candidate states (no age/region scheme exists for AU)                                                                                                                    | —                                                                       |
| `dvla_vehicle_enquiry`  | Make/colour/year/tax/MOT status (UK only)                                                                                                                                                                                          | `DVLA_VES_API_KEY`                                                      |
| `mot_history`           | Full MOT test history, mileage, defects (UK only)                                                                                                                                                                                  | `MOT_CLIENT_ID` / `MOT_CLIENT_SECRET` / `MOT_API_KEY` / `MOT_TOKEN_URL` |
| `beacon_search`         | Full-text search the index                                                                                                                                                                                                         | a running `beacon serve`                                                |
| `beacon_index_document` | Add/replace a document                                                                                                                                                                                                             | a running `beacon serve`                                                |
| `beacon_stats`          | Index statistics                                                                                                                                                                                                                   | a running `beacon serve`                                                |

## Run it

```bash
npm run build
node dist/mcp/index.js           # or: npx beacon-mcp   (after npm link / global install)
```

Environment (all optional — see [`.env.example`](../.env.example)):
`BEACON_API_URL`, `DVLA_VES_API_KEY`, `MOT_CLIENT_ID`, `MOT_CLIENT_SECRET`,
`MOT_API_KEY`, `MOT_TOKEN_URL`. A `.env` file is auto-loaded.

## Connect it

### Claude Code

This repo already ships a project-scoped [`.mcp.json`](../.mcp.json). From the repo
root just run `claude` and approve the `beacon-search` server, or add it explicitly:

```bash
claude mcp add beacon-search -- node dist/mcp/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "beacon-search": {
      "command": "node",
      "args": ["/absolute/path/to/abeaconsearch/dist/mcp/index.js"],
      "env": { "BEACON_API_URL": "http://127.0.0.1:7700" },
    },
  },
}
```

### Anything else

Any MCP client that can launch a stdio server works — point it at
`node dist/mcp/index.js`.

## Composing with other open-source MCP servers

The plate tools are self-contained, but they pair well with general-purpose
servers, e.g. run alongside the reference **fetch** and **filesystem** servers:

```bash
claude mcp add fetch -- uvx mcp-server-fetch
claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem "$PWD"
```

Then Claude can, in one session: fetch a page, extract registrations, call
`check_number_plate` on each, and `beacon_index_document` the results.
