import type { AnswerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { normalizeWhitespace, tokenize } from '../text.js';
import { clusterCandidates, looksLikeIdentityQuery, type EntityCandidate } from './evidence.js';
import {
  queryKeywords,
  scoreSentence,
  selectGroundedClaims,
  splitSentences,
  STOPWORDS,
  weaveExtractive,
  type GroundedClaim,
} from './extract.js';
import {
  createLlmSynthesizers,
  type LlmSynthesizer,
  type SynthesisExtract,
} from './providers/llm.js';
import { createWebSearchProviders, type WebSearchProvider } from './providers/web-search.js';
import { gatherSources, type EngineLike, type RetrievedSource } from './retrieval.js';
import type {
  AnswerCandidate,
  AnswerClaim,
  AnswerConfidence,
  AnswerResponse,
  AnswerSource,
  Synthesizer,
} from './types.js';

export { type EngineLike } from './retrieval.js';

/** Thrown when too many answer requests are already in flight. */
export class AnswerBusyError extends Error {
  constructor() {
    super('the answer service is busy; try again shortly');
    this.name = 'AnswerBusyError';
  }
}

export interface AnswerServiceDeps {
  engine: EngineLike;
  config: AnswerConfig;
  userAgent: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Overrides for tests. `null` forces index-only. An array queries those providers together. */
  webSearch?: WebSearchProvider | readonly WebSearchProvider[] | null;
  synthesizers?: LlmSynthesizer[];
  now?: () => Date;
}

export interface AnswerOptions {
  fresh?: boolean;
  signal?: AbortSignal;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 100;
const MAX_CONCURRENT = 4;
const LLM_SENTINEL = 'the available sources do not answer this question';
const NEGATION_RE =
  /\b(not|never|no longer|isn't|doesn't|didn't|wasn't|weren't|false|denies|denied|disputed|incorrect|debunked)\b/i;

function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

interface CacheEntry {
  value: AnswerResponse;
  expires: number;
}

export class AnswerService {
  private readonly deps: AnswerServiceDeps;
  private readonly cache = new Map<string, CacheEntry>();
  private inFlight = 0;

  constructor(deps: AnswerServiceDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Public capability summary for `/health` (no secrets). */
  get capabilities(): {
    enabled: true;
    autoAnswer: boolean;
    webSearch: string | null;
    llm: string[];
  } {
    const webSearch = this.resolveProviders();
    return {
      enabled: true,
      autoAnswer: this.deps.config.autoAnswer,
      webSearch:
        webSearch.length > 0 ? webSearch.map((provider) => provider.name).join(', ') : null,
      llm: this.resolveSynthesizers().map((s) => s.name),
    };
  }

  private resolveProviders(): WebSearchProvider[] {
    const override = this.deps.webSearch;
    if (override === undefined)
      return createWebSearchProviders(this.deps.config, this.deps.fetchImpl);
    if (override === null) return [];
    if (Array.isArray(override)) return [...override];
    return [override as WebSearchProvider];
  }

  private resolveSynthesizers(): LlmSynthesizer[] {
    return this.deps.synthesizers ?? createLlmSynthesizers(this.deps.config, this.deps.fetchImpl);
  }

  async answer(query: string, options: AnswerOptions = {}): Promise<AnswerResponse> {
    const normalized = normalizeWhitespace(query);
    const key = normalized.toLowerCase();

    if (!options.fresh) {
      const hit = this.cache.get(key);
      if (hit && hit.expires > Date.now()) return { ...hit.value, cached: true };
    }

    if (this.inFlight >= MAX_CONCURRENT) throw new AnswerBusyError();
    this.inFlight += 1;
    const startedAt = performance.now();
    try {
      const response = await this.build(normalized, options, startedAt);
      this.store(key, response);
      return response;
    } finally {
      this.inFlight -= 1;
    }
  }

  private store(key: string, value: AnswerResponse): void {
    this.cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async build(
    query: string,
    options: AnswerOptions,
    startedAt: number,
  ): Promise<AnswerResponse> {
    const warnings: string[] = [];
    const { sources: gathered, warnings: gatherWarnings } = await gatherSources(query, {
      engine: this.deps.engine,
      webSearch: this.resolveProviders(),
      config: this.deps.config,
      userAgent: this.deps.userAgent,
      fetchImpl: this.deps.fetchImpl,
      logger: this.deps.logger,
      signal: options.signal,
    });
    warnings.push(...gatherWarnings);

    // Boilerplate/off-topic/unconfirmed-identity sources never contribute a
    // claim (enforced in selectGroundedClaims) — but every web source is
    // still kept in the response so the reader can see what was found and
    // why it wasn't used. An index source only survives if it was actually
    // grounded, since the local index is usually large and most term matches
    // aren't claim-worthy.
    let grounded = selectGroundedClaims(query, gathered);
    const groundedIds = new Set(grounded.map((g) => g.sourceId));
    const kept = gathered.filter((s) => s.origin === 'web' || groundedIds.has(s.id));
    const idMap = new Map(kept.map((s, i) => [s.id, i + 1]));
    const retrieved: RetrievedSource[] = kept.map((s, i) => ({ ...s, id: i + 1 }));
    grounded = grounded
      .map((g) => ({ ...g, sourceId: idMap.get(g.sourceId) ?? 0 }))
      .filter((g) => g.sourceId > 0);

    const finish = (
      partial: Pick<
        AnswerResponse,
        | 'answer'
        | 'claims'
        | 'confidence'
        | 'confidenceReason'
        | 'synthesizer'
        | 'disclaimer'
        | 'identityConfidence'
        | 'sourceQuality'
        | 'searchGaps'
      >,
    ): AnswerResponse => {
      const citedIds = new Set(partial.claims.flatMap((c) => c.sourceIds));
      return {
        query,
        sources: retrieved.map((s) => this.toPublicSource(query, s, grounded, citedIds)),
        warnings,
        generatedAt: this.now().toISOString(),
        tookMs: Number((performance.now() - startedAt).toFixed(1)),
        cached: false,
        ...partial,
      };
    };

    if (retrieved.length === 0) {
      return finish({
        answer:
          'No reliable source was found for this query. Try rephrasing it, or add material through the Crawl or Add tabs so Beacon has something to answer from.',
        claims: [],
        confidence: 'none',
        confidenceReason: 'no sources could be retrieved from the index or the web',
        synthesizer: 'extractive',
        disclaimer: 'This response is not backed by any source.',
        identityConfidence: 0,
        sourceQuality: 0,
        searchGaps: this.buildSearchGaps(retrieved, warnings),
      });
    }

    // --- Identity resolution -------------------------------------------
    // For a person/entity-shaped query, lexical overlap is not identity
    // evidence: "Maiz Gustavo", "Gustavo Angel Maddonni", and a film called
    // "Los Guardianes del Maiz" must never be synthesized into one answer
    // just because they all mention a shared word. Cluster first; only
    // proceed to normal single-entity synthesis when exactly one cluster is
    // an exact name match *and* it actually has something usable to say —
    // zero exact matches, more than one distinct exact match, or a lone
    // exact match too thin to be useful (while other distinct entities were
    // also found) all mean identity isn't confidently resolved, so show the
    // candidates plainly instead of guessing or silently picking one.
    const isIdentityQuery = looksLikeIdentityQuery(query);
    if (isIdentityQuery) {
      const clusters = clusterCandidates(retrieved);
      const exactClusters = clusters.filter((c) => c.matchType === 'exact');
      const exactIsUsable =
        exactClusters.length === 1 &&
        retrieved.some((s) => exactClusters[0]?.sourceIds.includes(s.id) && s.usableForAnswer);
      // A confirmed exact-name match can still have nothing sentence-level
      // "grounded" for the query — e.g. a business page whose body never
      // repeats its own name. That's not the same as having no answer: fall
      // back to the same candidate-style description rather than reporting
      // "the sources do not answer this question" about a page we *know*
      // matches the name.
      const hasGroundedClaim = grounded.some((g) =>
        exactClusters[0]?.sourceIds.includes(g.sourceId),
      );
      if (!exactIsUsable || !hasGroundedClaim) {
        return this.candidatesResponse(query, retrieved, clusters, warnings, startedAt);
      }
    }

    const usableRetrieved = retrieved.filter((s) => s.usableForAnswer);
    if (usableRetrieved.length === 0) {
      const only = retrieved[0];
      const answer =
        retrieved.length === 1 && only
          ? `I found a ${only.origin === 'web' ? 'web page' : 'local document'} matching "${query}", but ${only.reason}.`
          : `${retrieved.length} sources were found for "${query}", but none contained substantive, relevant evidence.`;
      return finish({
        answer,
        claims: [],
        confidence: 'none',
        confidenceReason: 'no retrieved source contained usable evidence',
        synthesizer: 'extractive',
        disclaimer: 'This response is not backed by any usable source.',
        identityConfidence: isIdentityQuery ? 0 : 1,
        sourceQuality: 0,
        searchGaps: this.buildSearchGaps(retrieved, warnings),
      });
    }

    // --- Weave -------------------------------------------------------------
    const extracts = this.buildExtracts(usableRetrieved, grounded);
    let prose = weaveExtractive(grounded);
    let synthesizer: Synthesizer = 'extractive';

    for (const llm of this.resolveSynthesizers()) {
      try {
        const woven = await llm.weave({ query, extracts }, options.signal);
        prose = woven;
        synthesizer = llm.kind;
        break;
      } catch (error) {
        warnings.push(
          `${llm.name} synthesis failed (${error instanceof Error ? error.message : String(error)}); used the extractive fallback`,
        );
      }
    }

    const sentinelHit =
      synthesizer !== 'extractive' && prose.toLowerCase().replace(/[.\s]+$/, '') === LLM_SENTINEL;

    // --- Verify citations ------------------------------------------------
    const claims = sentinelHit ? [] : this.verify(prose, retrieved);
    const supported = claims.filter((c) => c.supported);
    const cleanAnswer = claims.map((c) => c.text).join(' ');
    const unsupportedRatio = claims.length === 0 ? 1 : 1 - supported.length / claims.length;

    const citedIds = new Set(claims.flatMap((c) => c.sourceIds));
    const citedSources = retrieved.filter((s) => citedIds.has(s.id));
    const conflicts = this.detectConflicts(grounded);

    // --- Confidence, from evidence quality rather than just a source count --
    const corroboration = citedSources.length;
    const hasOfficialOrEstablished = citedSources.some(
      (s) => s.trust === 'official' || s.trust === 'established',
    );
    const avgContentQuality = average(citedSources.map((s) => s.contentQualityScore));
    const avgIdentity = isIdentityQuery
      ? average(citedSources.map((s) => s.identityMatchScore))
      : 1;
    const avgSourceQuality = average(citedSources.map((s) => s.sourceQualityScore));

    let confidence: AnswerConfidence;
    let confidenceReason: string;
    if (sentinelHit || supported.length === 0) {
      confidence = 'none';
      confidenceReason = 'no statement in the answer could be tied to a retrieved source';
    } else if (conflicts.length > 0) {
      confidence = 'low';
      confidenceReason = 'sources disagree on a related point — see search gaps below';
    } else if (
      corroboration >= 2 &&
      hasOfficialOrEstablished &&
      avgIdentity >= 0.9 &&
      unsupportedRatio === 0
    ) {
      confidence = 'high';
      confidenceReason = `${corroboration} independent sources corroborate this, including a high-trust source`;
    } else if (
      (corroboration >= 2 || hasOfficialOrEstablished) &&
      avgContentQuality >= 0.5 &&
      unsupportedRatio <= 0.5
    ) {
      confidence = 'medium';
      confidenceReason =
        corroboration >= 2
          ? 'multiple sources broadly agree, though trust or identity confirmation is incomplete'
          : 'one substantive, high-trust source supports this, without independent corroboration';
    } else {
      confidence = 'low';
      confidenceReason = hasOfficialOrEstablished
        ? `${Math.round(unsupportedRatio * 100)}% of statements could not be tied to a source`
        : 'only weak, single-source, or low-quality evidence is available';
    }

    if (confidence === 'none') {
      return this.noneResponse(
        query,
        retrieved,
        grounded,
        warnings,
        synthesizer,
        prose,
        startedAt,
        isIdentityQuery,
      );
    }

    const disclaimer =
      confidence === 'high'
        ? undefined
        : this.disclaimerFor(citedSources, claims.length - supported.length);

    const searchGaps = this.buildSearchGaps(retrieved, warnings);
    searchGaps.push(...conflicts);
    if (corroboration === 1 && confidence !== 'high') {
      searchGaps.push('No independent source currently corroborates this.');
    }

    return finish({
      answer: cleanAnswer,
      claims,
      confidence,
      confidenceReason,
      synthesizer,
      disclaimer,
      identityConfidence: avgIdentity,
      sourceQuality: avgSourceQuality,
      searchGaps,
    });
  }

  /**
   * An identity-shaped query where the sources don't converge on one
   * confirmed match: list each candidate entity separately rather than
   * guessing which (if any) is the right one. Deterministic, not
   * LLM-generated — the exact behaviour the reader needs here (never merge,
   * never invent a connection) is safer guaranteed in code than hoped for
   * from a prompt.
   */
  private candidatesResponse(
    query: string,
    retrieved: RetrievedSource[],
    clusters: EntityCandidate[],
    warnings: string[],
    startedAt: number,
  ): AnswerResponse {
    const byId = new Map(retrieved.map((s) => [s.id, s]));
    // A source is only "used" if its text actually grounded part of a
    // candidate's summary — being merely acknowledged ("this page exists but
    // says nothing useful") does not count as evidence having been used.
    const citedIds = new Set<number>();
    const candidates: AnswerCandidate[] = clusters.map((cluster) => {
      const members = cluster.sourceIds
        .map((id) => byId.get(id))
        .filter((s): s is RetrievedSource => Boolean(s));
      const best = members.reduce(
        (a, b) => (b.contentQualityScore > a.contentQualityScore ? b : a),
        members[0] as RetrievedSource,
      );
      const cites = cluster.sourceIds.map((id) => `[${id}]`).join('');

      let summary: string;
      if (cluster.matchType === 'exact') {
        if (best.isBoilerplate) {
          summary = `A page titled "${cluster.label}" was found, but the retrieved content is mostly navigation/interface text and does not provide enough information to identify the person or establish useful facts. ${cites}`;
        } else {
          summary = `A page matching "${cluster.label}" was found. ${this.bestSentenceFor(query, best)} ${cites}`;
          for (const id of cluster.sourceIds) citedIds.add(id);
        }
      } else if (cluster.matchType === 'different') {
        summary = `"${cluster.label}" appears to be a different entity than the one searched for. ${cites}`;
      } else if (cluster.matchType === 'topical') {
        summary = `"${cluster.label}" is topically related but is not evidence about the person or entity searched for. ${cites}`;
      } else {
        summary = `"${cluster.label}" shares some words with the query but does not establish identity. ${cites}`;
      }
      return {
        label: cluster.label,
        matchType: cluster.matchType,
        sourceIds: cluster.sourceIds,
        summary: summary.trim(),
      };
    });

    const exactCount = candidates.filter((c) => c.matchType === 'exact').length;
    const answer =
      exactCount > 1
        ? `More than one page matches the exact name "${query}" — the retrieved sources do not say whether they are the same person, so they are kept as separate candidates below.`
        : `The retrieved sources do not appear to describe one clearly identifiable match for "${query}". ${candidates.length} possible candidate${candidates.length === 1 ? '' : 's'} ${candidates.length === 1 ? 'was' : 'were'} found instead.`;

    const identityConfidence = Math.min(
      0.3,
      Math.max(0, ...retrieved.map((s) => s.identityMatchScore)) * 0.3,
    );

    return {
      query,
      answer,
      claims: [],
      candidates,
      sources: retrieved.map((s) => this.toPublicSource(query, s, [], citedIds)),
      confidence: 'none',
      confidenceReason: 'no single source establishes a confirmed identity match',
      identityConfidence,
      sourceQuality: average(retrieved.map((s) => s.sourceQualityScore)),
      synthesizer: 'extractive',
      disclaimer:
        'None of the candidates below is confirmed as the person or entity you searched for — review the sources yourself before relying on any of them.',
      warnings,
      searchGaps: this.buildSearchGaps(retrieved, warnings, true),
      generatedAt: this.now().toISOString(),
      tookMs: Number((performance.now() - startedAt).toFixed(1)),
      cached: false,
    };
  }

  /**
   * The single best query-matching sentence in a source's text, for a
   * one-line candidate summary. When identity was already confirmed via the
   * title (an exact name match) rather than the body text, no sentence may
   * mention the query terms at all — that's not the same as having nothing
   * to say, so this still falls back to the source's first real sentence
   * rather than reporting a non-answer about a page that *does* match.
   */
  private bestSentenceFor(query: string, source: RetrievedSource): string {
    const terms = queryKeywords(query);
    const sentences = splitSentences(source.text);
    let best: { text: string; score: number } | undefined;
    for (const text of sentences) {
      const score = scoreSentence(text, terms, 1);
      if (!best || score > best.score) best = { text, score };
    }
    const chosen = best && best.score > 0 ? best.text : sentences[0];
    return chosen
      ? chosen.replace(/[.!?]+$/, '') + '.'
      : 'No further detail could be reliably extracted.';
  }

  /** Deterministic list of what's missing/uncertain — never LLM-generated, so it's always accurate. */
  private buildSearchGaps(
    retrieved: RetrievedSource[],
    warnings: string[],
    isCandidatesCase = false,
  ): string[] {
    const gaps: string[] = [];
    const unreachable = warnings.find((w) => w.includes('could not be fetched or read'));
    if (unreachable) gaps.push(unreachable);
    if (!isCandidatesCase) {
      const excluded = retrieved.filter((s) => !s.usableForAnswer).length;
      if (excluded > 0) {
        gaps.push(
          `${excluded} retrieved source${excluded === 1 ? '' : 's'} ${excluded === 1 ? 'was' : 'were'} found but not usable as evidence (navigation/boilerplate text, off-topic, or an unconfirmed identity match).`,
        );
      }
    }
    return gaps;
  }

  /**
   * Flags a *possible* disagreement between two grounded claims from
   * different sources: heavy topical overlap plus one asymmetric negation
   * marker ("X is not Y" vs "X is Y"). Deliberately conservative — this is a
   * heuristic, not real fact-checking, so it only fires on a fairly strong
   * signal rather than trying to catch every real disagreement.
   */
  private detectConflicts(grounded: GroundedClaim[]): string[] {
    const notes = new Set<string>();
    for (let i = 0; i < grounded.length; i++) {
      for (let j = i + 1; j < grounded.length; j++) {
        const a = grounded[i];
        const b = grounded[j];
        if (!a || !b || a.sourceId === b.sourceId) continue;
        const at = new Set(contentTokens(a.text));
        const bt = new Set(contentTokens(b.text));
        if (at.size === 0 || bt.size === 0) continue;
        let shared = 0;
        for (const t of at) if (bt.has(t)) shared += 1;
        const overlap = shared / Math.min(at.size, bt.size);
        if (overlap < 0.5) continue;
        if (NEGATION_RE.test(a.text) !== NEGATION_RE.test(b.text)) {
          notes.add(
            `Sources [${a.sourceId}] and [${b.sourceId}] appear to disagree on a related point.`,
          );
        }
      }
    }
    return [...notes];
  }

  private noneResponse(
    query: string,
    retrieved: RetrievedSource[],
    grounded: GroundedClaim[],
    warnings: string[],
    synthesizer: Synthesizer,
    prose: string,
    startedAt: number,
    isIdentityQuery: boolean,
  ): AnswerResponse {
    const base = {
      query,
      sources: retrieved.map((s) => this.toPublicSource(query, s, grounded, new Set<number>())),
      warnings,
      generatedAt: this.now().toISOString(),
      tookMs: Number((performance.now() - startedAt).toFixed(1)),
      cached: false,
      confidence: 'none' as const,
      confidenceReason: 'the retrieved sources do not answer this question',
      identityConfidence: isIdentityQuery ? 0 : 1,
      sourceQuality: 0,
      claims: [] as AnswerClaim[],
      searchGaps: this.buildSearchGaps(retrieved, warnings),
      disclaimer:
        'None of the retrieved sources answer this question. Anything below is unverified.',
    };

    if (synthesizer !== 'extractive') {
      const stripped = prose.replace(/\s*\[\d+\]/g, '').trim();
      if (stripped && stripped.toLowerCase().replace(/[.\s]+$/, '') !== LLM_SENTINEL) {
        return {
          ...base,
          synthesizer,
          answer: `Unverified — general knowledge, not backed by a retrieved source:\n\n${stripped}`,
        };
      }
    }
    return {
      ...base,
      synthesizer: 'extractive',
      answer:
        'The retrieved sources do not answer this question, and no verified answer is available.',
    };
  }

  private buildExtracts(sources: RetrievedSource[], grounded: GroundedClaim[]): SynthesisExtract[] {
    return sources.map((s) => {
      const own = grounded.filter((g) => g.sourceId === s.id).map((g) => g.text);
      const text = own.length > 0 ? own.join(' ') : s.text.slice(0, 500);
      return { id: s.id, source: `${s.trust} · ${s.domain ?? s.origin}`, text };
    });
  }

  private verify(prose: string, sources: RetrievedSource[]): AnswerClaim[] {
    const byId = new Map(sources.map((s) => [s.id, s]));
    return splitSentences(prose).map((raw) => {
      const ids = [...raw.matchAll(/\[(\d+)\]/g)]
        .map((m) => Number(m[1]))
        .filter((n) => byId.has(n));
      const uniqueIds = [...new Set(ids)];
      const text = normalizeWhitespace(raw.replace(/\s*\[\d+\]/g, '')).trim();

      let supported = false;
      if (uniqueIds.length > 0) {
        const citedTokens = new Set(
          uniqueIds.flatMap((id) => contentTokens(byId.get(id)?.text ?? '')),
        );
        const sentenceTokens = contentTokens(text);
        const shared = sentenceTokens.filter((t) => citedTokens.has(t)).length;
        supported =
          sentenceTokens.length === 0
            ? false
            : shared >= 4 || shared / sentenceTokens.length >= 0.4;
      }

      const cited = uniqueIds.map((id) => `[${id}]`).join('');
      return {
        text: cited ? `${text} ${cited}` : text,
        sourceIds: uniqueIds,
        supported,
      };
    });
  }

  private disclaimerFor(sources: RetrievedSource[], unsupported: number): string {
    const tiers = new Map<string, number>();
    for (const s of sources) tiers.set(s.trust, (tiers.get(s.trust) ?? 0) + 1);
    const mix = [...tiers.entries()].map(([tier, n]) => `${n} ${tier}`).join(', ') || 'no sources';
    const tail =
      unsupported > 0
        ? ` ${unsupported} statement${unsupported === 1 ? '' : 's'} could not be tied to a source and ${unsupported === 1 ? 'is' : 'are'} marked unverified.`
        : '';
    return `Based on ${sources.length} source${sources.length === 1 ? '' : 's'} (${mix}).${tail} Check the cited sources before relying on this.`;
  }

  private toPublicSource(
    query: string,
    source: RetrievedSource,
    grounded: GroundedClaim[],
    citedIds: Set<number>,
  ): AnswerSource {
    const own = grounded.filter((g) => g.sourceId === source.id).map((g) => g.text);
    const quote =
      own[0] ??
      (source.usableForAnswer
        ? this.bestSentenceFor(query, source)
        : `${source.reason.charAt(0).toUpperCase()}${source.reason.slice(1)}.`);
    return {
      id: source.id,
      title: source.title,
      url: source.url,
      origin: source.origin,
      domain: source.domain,
      trust: source.trust,
      trustReason: source.trustReason,
      retrievedAt: source.retrievedAt,
      live: source.live,
      quote,
      usedInAnswer: citedIds.has(source.id),
      matchType: source.entityMatchType,
    };
  }
}
