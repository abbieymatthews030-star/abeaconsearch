import type { WebResult, WebSearchProvider } from '../answer/providers/web-search.js';
import { queryVariants } from './intent.js';
import { webHitIsRelevant } from './relevance.js';
import type { SearchDiagnostic, SearchIntent } from './types.js';

export interface WebBackend {
  id: string;
  label: string;
  missingEnv: string[];
  provider: WebSearchProvider | null;
  /** `fast` runs on every live query; `deep` only when scholarly or the fast tier is empty. */
  tier?: 'fast' | 'deep';
}

export interface AnnotatedWebResult extends WebResult {
  provider: string;
  providerId: string;
}

export interface FanOutResult {
  results: AnnotatedWebResult[];
  attempts: SearchDiagnostic[];
  queriesTried: string[];
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function usableHits(value: unknown): { hits: WebResult[]; rejected: number } {
  if (!Array.isArray(value)) throw new Error('provider returned unusable search data');
  const hits = value.filter((hit): hit is WebResult => {
    if (!hit || typeof hit !== 'object') return false;
    const candidate = hit as Partial<WebResult>;
    if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) return false;
    if (typeof candidate.url !== 'string') return false;
    if (candidate.snippet !== undefined && typeof candidate.snippet !== 'string') return false;
    try {
      const url = new URL(candidate.url);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  });
  return { hits, rejected: value.length - hits.length };
}

/**
 * Ask every configured provider at once. A failure in one provider is recorded
 * and does not cancel the others. Each provider retries broader variants and
 * accumulates relevant hits across them.
 *
 * When `budgetMs` is set, unfinished backends are aborted and marked skipped so
 * a single slow source cannot hold the whole response.
 */
export async function fanOutWebSearch(options: {
  backends: WebBackend[];
  query: string;
  intent: SearchIntent;
  limit: number;
  signal?: AbortSignal;
  /** `strict` drops hits that do not share query tokens. `off` keeps every URL (used when a later fetch scores the page body). */
  filter: 'strict' | 'off';
  /** Overall wait for this fan-out. Omit to wait until every backend settles. */
  budgetMs?: number;
}): Promise<FanOutResult> {
  const variants = queryVariants(options.query, options.intent);
  const active = options.backends.filter((backend) => backend.provider);
  const idle = options.backends.filter((backend) => !backend.provider);

  const budgetController = new AbortController();
  const onParentAbort = () => budgetController.abort();
  if (options.signal) {
    if (options.signal.aborted) budgetController.abort();
    else options.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let budgetExhausted = false;
  if (options.budgetMs !== undefined && options.budgetMs >= 0) {
    budgetTimer = setTimeout(() => {
      budgetExhausted = true;
      budgetController.abort();
    }, options.budgetMs);
  }

  const signal = budgetController.signal;
  const runOptions = { ...options, signal };

  try {
    const settled = await Promise.all(
      active.map((backend) => runBackend(backend, variants, runOptions, () => budgetExhausted)),
    );

    const queriesTried: string[] = [];
    const results: AnnotatedWebResult[] = [];
    const attempts: SearchDiagnostic[] = idle.map((backend) => ({
      id: backend.id,
      label: backend.label,
      status: 'not_configured' as const,
      detail: `not configured — set ${backend.missingEnv.join(' or ')}`,
      missingEnv: backend.missingEnv,
      resultCount: 0,
    }));

    for (const item of settled) {
      attempts.push(item.diagnostic);
      results.push(...item.hits);
      for (const tried of item.tried) {
        if (!queriesTried.some((existing) => existing.toLowerCase() === tried.toLowerCase())) {
          queriesTried.push(tried);
        }
      }
    }

    if (queriesTried.length === 0 && variants.length > 0) {
      queriesTried.push(...variants.slice(0, 1));
    }

    return { results, attempts, queriesTried };
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
    if (options.signal) options.signal.removeEventListener('abort', onParentAbort);
  }
}

async function runBackend(
  backend: WebBackend,
  variants: string[],
  options: { query: string; limit: number; signal?: AbortSignal; filter: 'strict' | 'off' },
  wasBudgetExhausted: () => boolean,
): Promise<{ hits: AnnotatedWebResult[]; tried: string[]; diagnostic: SearchDiagnostic }> {
  const provider = backend.provider;
  const started = performance.now();
  const tried: string[] = [];
  const hits: AnnotatedWebResult[] = [];
  const seenUrls = new Set<string>();
  const errors: string[] = [];
  let rejectedHits = 0;
  let successfulResponses = 0;
  let skippedForBudget = false;

  // Callers only pass backends that already have a provider (active filter).
  if (!provider) {
    throw new Error(`web backend "${backend.id}" has no provider`);
  }

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    if (!variant) continue;
    if (options.signal?.aborted) {
      skippedForBudget = wasBudgetExhausted();
      if (!skippedForBudget && hits.length === 0 && errors.length === 0) {
        errors.push('aborted');
      }
      break;
    }
    tried.push(variant);
    try {
      const response = await provider.search(variant, options.limit, options.signal);
      const sanitized = usableHits(response);
      const found = sanitized.hits;
      rejectedHits += sanitized.rejected;
      if (response.length > 0 && found.length === 0) {
        throw new Error('provider returned only unusable search results');
      }
      successfulResponses += 1;
      const relevant =
        options.filter === 'off'
          ? found
          : found.filter((hit) => webHitIsRelevant(options.query, variant, hit.title, hit.snippet));
      if (relevant.length > 0) {
        for (const hit of relevant) {
          const key = new URL(hit.url);
          key.hash = '';
          if (seenUrls.has(key.toString())) continue;
          seenUrls.add(key.toString());
          hits.push({ ...hit, provider: provider.name, providerId: backend.id });
        }
      }
    } catch (err) {
      if (isAbortError(err) || options.signal?.aborted) {
        skippedForBudget = wasBudgetExhausted();
        if (!skippedForBudget && options.signal?.aborted) {
          errors.push(err instanceof Error ? err.message : String(err));
          break;
        }
        if (skippedForBudget) break;
      }
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const tookMs = Math.round(performance.now() - started);
  if (skippedForBudget && hits.length === 0) {
    return {
      hits,
      tried,
      diagnostic: {
        id: backend.id,
        label: backend.label,
        status: 'skipped',
        detail: 'search budget exhausted',
        missingEnv: [],
        tookMs,
        resultCount: 0,
      },
    };
  }

  return {
    hits,
    tried,
    diagnostic: {
      id: backend.id,
      label: backend.label,
      status: errors.length > 0 && successfulResponses === 0 && hits.length === 0 ? 'error' : 'ok',
      detail:
        errors.length > 0
          ? `${hits.length > 0 ? `${hits.length} relevant` : 'no results'}; retried ${errors.length} failed response${errors.length === 1 ? '' : 's'} (${errors[errors.length - 1]})`
          : rejectedHits > 0
            ? `${hits.length} relevant; discarded ${rejectedHits} unusable result${rejectedHits === 1 ? '' : 's'}`
          : hits.length > 0
            ? `${hits.length} relevant`
            : 'no relevant results',
      missingEnv: [],
      tookMs,
      resultCount: hits.length,
    },
  };
}
