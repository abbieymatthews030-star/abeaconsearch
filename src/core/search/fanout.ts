import type { WebResult, WebSearchProvider } from '../answer/providers/web-search.js';
import { queryVariants } from './intent.js';
import { webHitIsRelevant } from './relevance.js';
import type { SearchDiagnostic, SearchIntent } from './types.js';

export interface WebBackend {
  id: string;
  label: string;
  missingEnv: string[];
  provider: WebSearchProvider | null;
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

/**
 * Ask every configured provider at once. A failure in one provider is recorded
 * and does not cancel the others. Variants run from exact to broad, and stop
 * once a provider has relevant hits — or once a later variant comes back
 * obviously unrelated.
 */
export async function fanOutWebSearch(options: {
  backends: WebBackend[];
  query: string;
  intent: SearchIntent;
  limit: number;
  signal?: AbortSignal;
  /** `strict` drops hits that do not share query tokens. `off` keeps every URL (used when a later fetch scores the page body). */
  filter: 'strict' | 'off';
}): Promise<FanOutResult> {
  const variants = queryVariants(options.query, options.intent);
  const active = options.backends.filter((backend) => backend.provider);
  const idle = options.backends.filter((backend) => !backend.provider);

  const settled = await Promise.all(
    active.map((backend) => runBackend(backend, variants, options)),
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
}

async function runBackend(
  backend: WebBackend,
  variants: string[],
  options: { query: string; limit: number; signal?: AbortSignal; filter: 'strict' | 'off' },
): Promise<{ hits: AnnotatedWebResult[]; tried: string[]; diagnostic: SearchDiagnostic }> {
  const provider = backend.provider;
  const started = performance.now();
  const tried: string[] = [];
  const hits: AnnotatedWebResult[] = [];
  let error: string | undefined;

  if (!provider) {
    return {
      hits,
      tried,
      diagnostic: {
        id: backend.id,
        label: backend.label,
        status: 'not_configured',
        detail: `not configured — set ${backend.missingEnv.join(' or ')}`,
        missingEnv: backend.missingEnv,
        resultCount: 0,
      },
    };
  }

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    if (!variant) continue;
    tried.push(variant);
    try {
      const found = await provider.search(variant, options.limit, options.signal);
      const relevant =
        options.filter === 'off'
          ? found
          : found.filter((hit) => webHitIsRelevant(options.query, variant, hit.title, hit.snippet));
      if (relevant.length > 0) {
        for (const hit of relevant) {
          hits.push({ ...hit, provider: provider.name, providerId: backend.id });
        }
        break;
      }
      // Early variants (exact, normalized) can miss without the query being
      // unrelated. Later variants that come back populated but off-topic are
      // the signal to stop broadening.
      if (options.filter === 'strict' && i >= 2 && found.length > 0) break;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  return {
    hits,
    tried,
    diagnostic: {
      id: backend.id,
      label: backend.label,
      status: error ? 'error' : 'ok',
      detail: error ?? (hits.length > 0 ? `${hits.length} relevant` : 'no relevant results'),
      missingEnv: [],
      tookMs: Math.round(performance.now() - started),
      resultCount: hits.length,
    },
  };
}
