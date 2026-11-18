# Answer weave

Beacon can return a short written **answer** for a query, not just a list of
hits. The answer is only ever assembled from sources it actually retrieved, and
it is explicit about where every statement comes from and how far to trust it.

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
   - Live web: every configured backend is queried in parallel — keyed ones
     (`BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` / `SEARXNG_URL`) plus keyless
     DuckDuckGo, Wikipedia, and deep free sources (OpenAlex, Crossref, arXiv,
     Europe PMC, Wikidata, Internet Archive, Open Library, DOAJ, Library of
     Congress, Project Gutenberg) when `BEACON_KEYLESS_WEB_SEARCH` is on. Top
     URLs are fetched through the SSRF guard (`hostIsPrivate`) and `robots.txt`,
     then reduced to readable text. Unreachable / blocked URLs become `warnings`.
   - Sources are de-duplicated by URL and capped at `BEACON_ANSWER_MAX_SOURCES`.
2. **Ground** (`src/core/answer/extract.ts`) — each source is split into
   sentences; the sentences that best cover the query terms (weighted by source
   trust) are selected and kept tied to their source id. Index sources that
   contribute no relevant sentence are dropped.
3. **Weave** (`src/core/answer/providers/llm.ts`) — the grounded sentences and a
   short excerpt per source are handed to an LLM with a strict instruction to
   use only those extracts and to cite every sentence. Providers are tried in
   order: Anthropic (`ANTHROPIC_API_KEY`), then any OpenAI-compatible endpoint
   (`OPENAI_API_KEY` + `BEACON_ANSWER_OPENAI_MODEL`). If none is configured, or
   all fail, the deterministic weave from step 2 is used and `synthesizer` is
   `extractive`.
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
the answer is either an honest "the sources don't answer this" line or, if an
LLM ran, a single paragraph explicitly prefixed **"Unverified — general
knowledge, not backed by a retrieved source"**. The endpoint always returns a
non-empty answer.
