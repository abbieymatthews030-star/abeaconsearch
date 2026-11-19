# Answer weave

Beacon can return a short written **answer** for a query, not just a list of
hits. Prefer retrieved sources and cite them; when sources are missing or thin,
an LLM knowledge fallback still produces an answer (marked unverified). The
response is explicit about trust, citations, and the narrow deny list.

- Web UI: the Search tab auto-runs an answer for question-like queries
  (`?` present, starts with who/what/how/…, or ≥ 4 words). Other queries get a
  "weave an answer" button. Disable the auto behaviour with
  `BEACON_ANSWER_AUTO=false`.
- API: `GET /api/answer?q=<query>&fresh=<bool>`. `fresh=true` bypasses the
  5-minute in-process answer cache.
- Off switch: `BEACON_ANSWER_ENABLED=false` removes the route and hides the card.

## Pipeline

1. **Retrieve** (`src/core/answer/retrieval.ts`)
   - Local index: an OR-combined search, top _n_ documents.
   - Live web: configured backends are queried in parallel under
     `BEACON_SEARCH_BUDGET_MS` — keyed ones (`BRAVE_SEARCH_API_KEY` /
     `TAVILY_API_KEY` / `SEARXNG_URL`) plus keyless DuckDuckGo / Wikipedia, with
     deep free sources (OpenAlex, Crossref, arXiv, Europe PMC, Wikidata,
     Internet Archive, Open Library, DOAJ, Library of Congress, Project
     Gutenberg) when `BEACON_KEYLESS_WEB_SEARCH` is on and the query needs them.
     Top URLs are fetched through the SSRF guard (`hostIsPrivate`) and
     `robots.txt`, then reduced to readable text. Unreachable / blocked URLs
     become `warnings`.
   - Sources are de-duplicated by URL and capped at `BEACON_ANSWER_MAX_SOURCES`.
2. **Ground** (`src/core/answer/extract.ts`) — each source is split into
   sentences; the sentences that best cover the query terms (weighted by source
   trust) are selected and kept tied to their source id. Index sources that
   contribute no relevant sentence are dropped.
3. **Weave** (`src/core/answer/providers/llm.ts`) — the grounded sentences and a
   short excerpt per source are handed to an LLM that must always answer (no
   moral refusals), preferring extracts and citing them, then filling gaps from
   general knowledge when needed. Soft model refusals are retried once.
   Providers are tried in order: Anthropic (`ANTHROPIC_API_KEY`), then any
   OpenAI-compatible endpoint (`OPENAI_API_KEY` + `BEACON_ANSWER_OPENAI_MODEL`).
   If none is configured, or all fail, the deterministic weave from step 2 is
   used and `synthesizer` is `extractive`.
4. **Verify** (`src/core/answer/answer-service.ts`) — the woven prose is split
   back into sentences; `[n]` markers pointing at a non-existent source are
   dropped, and each sentence is checked for token overlap against the text of
   the sources it cites. Sentences that fail are marked `supported: false`.

## Trust tiers

Assigned from the source URL (`src/core/answer/trust.ts`):

| Tier          | What it means                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `official`    | `.gov` / `.gov.uk` / `.mil` / `.int` / `.edu` / `.ac.uk` / `nhs.uk` / EU / UN / WHO / …, or a domain listed in `BEACON_ANSWER_TRUSTED_DOMAINS`                                                                        |
| `established` | curated encyclopedias, wire services, standards bodies, peer-reviewed / open-scholarship publishers (Wikipedia, Wikidata, Reuters, Nature, arXiv, Crossref/DOI, OpenAlex, Europe PMC, Internet Archive, W3C, IETF, …) |
| `community`   | any other page that was fetched successfully or is in the index with a URL                                                                                                                                            |
| `unverified`  | no URL, the page could not be fetched, or an LLM-only statement                                                                                                                                                       |

## Confidence

| Value    | Condition                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `high`   | ≥ 2 sources incl. an `official`/`established` one, at least one fetched live, every statement supported |
| `medium` | at least one `official`/`established` source and ≤ half the statements unsupported                      |
| `low`    | only `community`/`unverified` sources, or > half the statements unsupported                             |
| `none`   | no statement could be tied to a source                                                                  |

A `disclaimer` is attached for anything below `high`. When confidence is `none`
and an LLM is configured, Beacon still returns an answer — prefixed
**"Unverified — …"** — generated from whatever extracts exist plus general
knowledge. With no LLM and no usable sources, the response explains how to
enable generation or add material. The endpoint always returns a non-empty
answer for allowed topics.

## Content policy

Answers are **not refused** for morally grey, illegal-in-some-places, or
ethically debatable topics. The only deny list (see
`src/core/answer/content-policy.ts`) is:

- bestiality / zoophilia
- sexual violence against women
- physical violence against women

Those queries return `denied: true` with a short fixed message and no sources.
Everything else is answered from retrieved sources when possible, otherwise
from an automatic knowledge fallback when an LLM is configured.
