import { randomUUID } from 'node:crypto';
import MiniSearch from 'minisearch';
import { highlight, makeSnippet, normalizeWhitespace, slugify, tokenize } from './text.js';
import type {
  BeaconDocument,
  DocumentInput,
  IndexSnapshot,
  IndexStats,
  SearchHit,
  SearchQuery,
  SearchResponse,
} from './types.js';

interface IndexedDoc {
  id: string;
  title: string;
  body: string;
  tags: string;
}

export interface SearchEngineEvents {
  /** Called after any mutation (upsert / remove / bulk load). */
  onChange?: () => void;
}

/**
 * In-memory full-text search index built on MiniSearch, with the original
 * documents kept alongside so results can carry snippets and metadata.
 */
export class SearchEngine {
  private mini: MiniSearch<IndexedDoc>;
  private readonly docs = new Map<string, BeaconDocument>();
  private readonly onChange?: () => void;
  lastPersistedAt: string | null = null;

  /**
   * Insertion order, keyed by doc id. `updatedAt` is millisecond-resolution,
   * so a bulk import (many `upsert` calls in one synchronous loop) routinely
   * gives a whole batch the same timestamp; this breaks newest/oldest ties.
   */
  private readonly sequence = new Map<string, number>();
  private nextSequence = 0;

  constructor(events: SearchEngineEvents = {}) {
    this.onChange = events.onChange;
    this.mini = SearchEngine.createIndex();
  }

  private static createIndex(): MiniSearch<IndexedDoc> {
    return new MiniSearch<IndexedDoc>({
      idField: 'id',
      fields: ['title', 'body', 'tags'],
      storeFields: [],
      searchOptions: {
        boost: { title: 3, tags: 2 },
        combineWith: 'AND',
      },
    });
  }

  private toIndexed(doc: BeaconDocument): IndexedDoc {
    return { id: doc.id, title: doc.title, body: doc.body, tags: doc.tags.join(' ') };
  }

  get size(): number {
    return this.docs.size;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  get(id: string): BeaconDocument | undefined {
    return this.docs.get(id);
  }

  list(): BeaconDocument[] {
    return [...this.docs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Insert or replace a document. Returns the stored document. */
  upsert(input: DocumentInput): BeaconDocument {
    const now = new Date().toISOString();
    const id = input.id?.trim() || slugify(input.title) || randomUUID();
    const existing = this.docs.get(id);

    const doc: BeaconDocument = {
      id,
      title: normalizeWhitespace(input.title),
      body: input.body ?? '',
      url: input.url,
      tags: [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))],
      source: input.source,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (existing) this.mini.discard(id);
    this.docs.set(id, doc);
    this.sequence.set(id, this.nextSequence++);
    this.mini.add(this.toIndexed(doc));
    this.onChange?.();
    return doc;
  }

  remove(id: string): boolean {
    if (!this.docs.has(id)) return false;
    this.mini.discard(id);
    this.docs.delete(id);
    this.sequence.delete(id);
    this.onChange?.();
    return true;
  }

  clear(): void {
    this.docs.clear();
    this.sequence.clear();
    this.nextSequence = 0;
    this.mini = SearchEngine.createIndex();
    this.onChange?.();
  }

  /** Replace the entire index contents (used when loading a snapshot). */
  replaceAll(documents: BeaconDocument[]): void {
    this.docs.clear();
    this.sequence.clear();
    this.nextSequence = 0;
    this.mini = SearchEngine.createIndex();
    for (const doc of documents) {
      this.docs.set(doc.id, doc);
      this.sequence.set(doc.id, this.nextSequence++);
    }
    this.mini.addAll([...this.docs.values()].map((doc) => this.toIndexed(doc)));
    this.onChange?.();
  }

  search(query: SearchQuery, options: { combineWith?: 'AND' | 'OR' } = {}): SearchResponse {
    const startedAt = performance.now();
    const q = query.q.trim();
    const queryTerms = tokenize(q);

    let ranked: Array<{ doc: BeaconDocument; score: number; terms: string[] }>;

    if (q.length === 0) {
      ranked = this.list().map((doc) => ({ doc, score: 0, terms: [] }));
    } else {
      ranked = this.mini
        .search(q, {
          prefix: query.prefix,
          fuzzy: query.fuzzy ? 0.2 : false,
          boost: { title: 3, tags: 2 },
          combineWith: options.combineWith ?? 'AND',
        })
        .map((result) => {
          const doc = this.docs.get(String(result.id));
          if (!doc) return null;
          const terms = [...new Set([...result.terms, ...queryTerms])];
          return { doc, score: result.score, terms };
        })
        .filter((v): v is { doc: BeaconDocument; score: number; terms: string[] } => v !== null);
    }

    const filtered = ranked.filter(({ doc }) => {
      if (query.source && doc.source !== query.source) return false;
      if (query.tags.length > 0 && !query.tags.every((tag) => doc.tags.includes(tag))) return false;
      return true;
    });

    const sorted = this.applySort(filtered, query.sort);

    const facets = { tags: {} as Record<string, number>, sources: {} as Record<string, number> };
    for (const { doc } of filtered) {
      for (const tag of doc.tags) facets.tags[tag] = (facets.tags[tag] ?? 0) + 1;
      if (doc.source) facets.sources[doc.source] = (facets.sources[doc.source] ?? 0) + 1;
    }

    const page = sorted.slice(query.offset, query.offset + query.limit);
    const hits: SearchHit[] = page.map(({ doc, score, terms }) => ({
      id: doc.id,
      score: Number(score.toFixed(4)),
      title: highlight(doc.title, terms),
      url: doc.url,
      tags: doc.tags,
      source: doc.source,
      snippet: highlight(makeSnippet(doc.body, terms), terms),
      terms,
    }));

    const response: SearchResponse = {
      query: q,
      total: sorted.length,
      limit: query.limit,
      offset: query.offset,
      tookMs: Number((performance.now() - startedAt).toFixed(2)),
      hits,
      facets,
    };

    if (q.length > 0 && sorted.length === 0) {
      const suggestion = this.didYouMean(q);
      if (suggestion) response.suggestion = suggestion;
    }

    return response;
  }

  private applySort(
    ranked: Array<{ doc: BeaconDocument; score: number; terms: string[] }>,
    sort: SearchQuery['sort'],
  ): Array<{ doc: BeaconDocument; score: number; terms: string[] }> {
    const seq = (id: string) => this.sequence.get(id) ?? -1;
    switch (sort) {
      case 'newest':
        return [...ranked].sort(
          (a, b) =>
            b.doc.updatedAt.localeCompare(a.doc.updatedAt) || seq(b.doc.id) - seq(a.doc.id),
        );
      case 'oldest':
        return [...ranked].sort(
          (a, b) =>
            a.doc.updatedAt.localeCompare(b.doc.updatedAt) || seq(a.doc.id) - seq(b.doc.id),
        );
      case 'title':
        return [...ranked].sort((a, b) => a.doc.title.localeCompare(b.doc.title));
      case 'relevance':
      default:
        return ranked;
    }
  }

  /**
   * For a query that matched nothing, find a nearby indexed spelling, if any.
   *
   * Deliberately avoids `MiniSearch#autoSuggest` — see the note on `suggest`
   * below: it can join distinct terms that match the query across different
   * fields of the same document (e.g. "crawler crawling") into one
   * suggestion, which reads as garbled rather than a spelling correction.
   */
  private didYouMean(q: string): string | undefined {
    const query = q.trim().toLowerCase();
    const bestScore = new Map<string, number>();
    for (const result of this.mini.search(q, { prefix: false, fuzzy: 0.2 })) {
      for (const term of result.terms) {
        if (term.toLowerCase() === query) continue;
        bestScore.set(term, Math.max(bestScore.get(term) ?? 0, result.score));
      }
    }
    const [top] = [...bestScore.entries()].sort((a, b) => b[1] - a[1]);
    return top?.[0];
  }

  /**
   * Suggest term completions for a partial query, for search-as-you-type.
   *
   * `MiniSearch#autoSuggest` isn't a fit here: it joins every term that
   * matched a given result *across all fields* into one suggestion phrase
   * (e.g. a document titled "Crawling websites" whose body says "crawler"
   * would suggest "crawler crawling" for the prefix "craw"). Search directly
   * and collect the individual matched terms that actually extend the query.
   */
  suggest(q: string, limit = 8): string[] {
    const query = q.trim();
    if (!query) return [];
    const prefix = query.toLowerCase();
    const bestScore = new Map<string, number>();
    for (const result of this.mini.search(query, { prefix: true, fuzzy: 0.2 })) {
      for (const term of result.terms) {
        if (!term.toLowerCase().startsWith(prefix)) continue;
        bestScore.set(term, Math.max(bestScore.get(term) ?? 0, result.score));
      }
    }
    return [...bestScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([term]) => term);
  }

  stats(indexFile: string): IndexStats {
    const tagCounts = new Map<string, number>();
    const sourceCounts = new Map<string, number>();
    for (const doc of this.docs.values()) {
      for (const tag of doc.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      if (doc.source) sourceCounts.set(doc.source, (sourceCounts.get(doc.source) ?? 0) + 1);
    }
    const top = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20);

    return {
      documents: this.docs.size,
      tags: tagCounts.size,
      sources: sourceCounts.size,
      topTags: top(tagCounts).map(([tag, count]) => ({ tag, count })),
      topSources: top(sourceCounts).map(([source, count]) => ({ source, count })),
      indexFile,
      lastPersistedAt: this.lastPersistedAt,
    };
  }

  toSnapshot(): IndexSnapshot {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      documents: [...this.docs.values()],
    };
  }
}
