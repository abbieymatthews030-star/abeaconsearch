import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type AnswerConfidence,
  type AnswerResponse,
  type AnswerSource,
  type BeaconDocument,
  type CalculationPrimary,
  type DiagnosticsResponse,
  type DomainPrimary,
  type EntityMatchType,
  type HealthResponse,
  type IpPrimary,
  type PlateCheck,
  type PrimaryResult,
  type ProviderStatus,
  type QueryKind,
  type SearchAction,
  type SearchSort,
  type SettingsEntry,
  type TrustTier,
  type UniversalQueryResponse,
} from './api';
import {
  CLIENT_SETTINGS,
  clientSettingsInSection,
  inSection,
  searchSettings,
  serverEntryToDefinition,
  type SettingDefinition,
  type SettingSection,
} from './settings-registry';

type Tab = 'search' | 'history' | 'settings' | 'docs';

const DEFAULT_PAGE_SIZE = 10;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function localeForRegion(region: unknown): string | undefined {
  switch (region) {
    case 'AU':
      return 'en-AU';
    case 'UK':
      return 'en-GB';
    case 'US':
      return 'en-US';
    default:
      return undefined;
  }
}

function relativeTime(iso: string, region?: unknown): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const secs = Math.max(1, Math.round((Date.now() - then) / 1000));
  const rtf = new Intl.RelativeTimeFormat(localeForRegion(region), { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (secs >= size) return rtf.format(-Math.round(secs / size), unit);
  }
  return rtf.format(-secs, 'second');
}

function formatCount(n: number, region?: unknown): string {
  return n.toLocaleString(localeForRegion(region));
}

function retentionMs(days: unknown): number | null {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * 86_400_000;
}

function pruneHistory(entries: HistoryEntry[], days: unknown): HistoryEntry[] {
  const windowMs = retentionMs(days);
  const cutoff = windowMs == null ? null : Date.now() - windowMs;
  const fresh =
    cutoff == null ? entries : entries.filter((entry) => new Date(entry.at).getTime() >= cutoff);
  return fresh.slice(0, HISTORY_LIMIT);
}

function stripCitations(text: string): string {
  return text.replace(/\s*\[\d+\]/g, '').trim();
}

const TRUST_LABEL: Record<TrustTier, string> = {
  official: 'official',
  established: 'established',
  community: 'unverified reliability',
  unverified: 'unverified',
};

const KIND_LABEL: Record<QueryKind, string> = {
  domain: 'domain',
  ip: 'ip address',
  calculation: 'calculation',
  plate: 'plate check',
  default: 'search',
};

/** ASCII-style radial dot burst — the "beacon". Pure SVG, inherits color. */
function Beacon({ size = 200 }: { size?: number }): JSX.Element {
  const c = size / 2;
  const maxR = c - size * 0.03;
  const step = size * 0.056;
  const dots: JSX.Element[] = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    const reach = i % 4 === 0 ? maxR : maxR * 0.6;
    for (let r = size * 0.06; r <= reach + 0.01; r += step) {
      dots.push(
        <circle
          key={`${i}-${r.toFixed(1)}`}
          cx={c + Math.cos(angle) * r}
          cy={c + Math.sin(angle) * r}
          r={r < maxR * 0.32 ? size * 0.013 : size * 0.009}
        />,
      );
    }
  }
  return (
    <svg
      className="beacon"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label="Beacon"
    >
      {dots}
      <circle cx={c} cy={c} r={size * 0.02} />
    </svg>
  );
}

// --- Local, per-browser query history ----------------------------------------
// There is no server-side history store — this is a convenience for the
// person at this browser, not shared data, so it lives in localStorage.

const HISTORY_KEY = 'beacon:history';
const HISTORY_LIMIT = 50;

interface HistoryEntry {
  query: string;
  kind: QueryKind;
  at: string;
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    /* storage can be unavailable (private browsing, quota) — history is a convenience */
  }
}

// --- Client-only settings (General / most of Search / most of Privacy) ------
// These never touch the server — they're per-browser preferences, persisted
// to localStorage, metadata-driven by `CLIENT_SETTINGS` in settings-registry.

const CLIENT_SETTINGS_KEY = 'beacon:settings';

type ClientSettingValues = Record<string, unknown>;

function defaultClientSettings(): ClientSettingValues {
  const values: ClientSettingValues = {};
  for (const def of CLIENT_SETTINGS) values[def.id] = def.defaultValue;
  return values;
}

function loadClientSettings(): ClientSettingValues {
  const defaults = defaultClientSettings();
  try {
    const raw = localStorage.getItem(CLIENT_SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed: unknown = JSON.parse(raw);
    return { ...defaults, ...(typeof parsed === 'object' && parsed !== null ? parsed : {}) };
  } catch {
    return defaults;
  }
}

function saveClientSettings(values: ClientSettingValues): void {
  try {
    localStorage.setItem(CLIENT_SETTINGS_KEY, JSON.stringify(values));
  } catch {
    /* storage can be unavailable (private browsing, quota) */
  }
}

interface ClientSettingsApi {
  values: ClientSettingValues;
  setValue: (id: string, value: unknown) => void;
  resetIds: (ids: string[]) => void;
}

function useClientSettings(): ClientSettingsApi {
  const [values, setValues] = useState<ClientSettingValues>(() => loadClientSettings());

  const setValue = useCallback((id: string, value: unknown) => {
    setValues((prev) => {
      const next = { ...prev, [id]: value };
      saveClientSettings(next);
      return next;
    });
  }, []);

  const resetIds = useCallback((ids: string[]) => {
    setValues((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        const def = CLIENT_SETTINGS.find((d) => d.id === id);
        if (def) next[id] = def.defaultValue;
      }
      saveClientSettings(next);
      return next;
    });
  }, []);

  return { values, setValue, resetIds };
}

/** How many distinct sources/capabilities Beacon currently has wired up. */
function countConnectedSources(health: HealthResponse | null): number {
  if (!health) return 0;
  let n = 1; // the local full-text index is always available
  if (health.lookups.enabled) n += 1; // domain / IP lookups (DNS + RDAP)
  if (health.plateChecks.vehicleData) n += 1;
  if (health.plateChecks.motHistory) n += 1;
  if (health.answer.webSearch) n += 1;
  if (health.answer.llm.length > 0) n += 1;
  return n;
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('search');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const clientSettings = useClientSettings();

  const refreshHealth = useCallback(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);
  useEffect(refreshHealth, [refreshHealth]);

  const retentionDays = clientSettings.values.historyRetentionDays;
  const saveSearchHistory = clientSettings.values.saveSearchHistory !== false;
  const region = clientSettings.values.region;

  useEffect(() => {
    setHistory((prev) => {
      const next = pruneHistory(prev, retentionDays);
      if (next.length === prev.length && next.every((entry, i) => entry === prev[i])) return prev;
      saveHistory(next);
      return next;
    });
  }, [retentionDays]);

  const recordHistory = useCallback(
    (query: string, kind: QueryKind) => {
      const q = query.trim();
      if (!q || !saveSearchHistory) return;
      setHistory((prev) => {
        if (prev[0]?.query === q) return prev;
        const next = pruneHistory(
          [{ query: q, kind, at: new Date().toISOString() }, ...prev.filter((e) => e.query !== q)],
          retentionDays,
        );
        saveHistory(next);
        return next;
      });
    },
    [retentionDays, saveSearchHistory],
  );

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
  }, []);

  const runFromHistory = (query: string) => {
    setInput(query);
    setTab('search');
  };

  const connectedSources = countConnectedSources(health);
  const density =
    typeof clientSettings.values.interfaceDensity === 'string'
      ? clientSettings.values.interfaceDensity
      : 'comfortable';

  return (
    <div className="app" data-density={density}>
      <header className="app__header">
        <div className="brand">
          <Beacon size={40} />
          <h1>ABEACON</h1>
          <p>multi-source search</p>
        </div>
        <nav className="tabs" aria-label="Sections">
          {(
            [
              ['search', 'Search'],
              ['history', 'History'],
              ['settings', 'Settings'],
              ['docs', 'Docs'],
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app__main">
        {tab === 'search' && (
          <SearchView
            input={input}
            onInputChange={setInput}
            onCommit={recordHistory}
            health={health}
            clientSettings={clientSettings}
          />
        )}
        {tab === 'history' && (
          <HistoryView
            entries={history}
            region={region}
            onPick={runFromHistory}
            onClear={clearHistory}
          />
        )}
        {tab === 'settings' && (
          <SettingsView
            health={health}
            onSettingsChanged={refreshHealth}
            clientSettings={clientSettings}
            historyCount={history.length}
            onClearHistory={clearHistory}
          />
        )}
        {tab === 'docs' && <DocsView />}
      </main>

      <footer className="app__footer">
        {health ? (
          <span>
            {connectedSources} source{connectedSources === 1 ? '' : 's'} connected
          </span>
        ) : (
          <span>Index status unavailable</span>
        )}
        <a href="/api/health" target="_blank" rel="noreferrer">
          API health
        </a>
      </footer>
    </div>
  );
}

const SORT_OPTIONS: Array<[SearchSort, string]> = [
  ['relevance', 'relevance'],
  ['newest', 'newest'],
  ['oldest', 'oldest'],
  ['title', 'title a–z'],
];

function SearchView({
  input,
  onInputChange,
  onCommit,
  health,
  clientSettings,
}: {
  input: string;
  onInputChange: (value: string) => void;
  onCommit: (query: string, kind: QueryKind) => void;
  health: HealthResponse | null;
  clientSettings: ClientSettingsApi;
}): JSX.Element {
  const resultsPerPage = Number(clientSettings.values.resultsPerPage) || DEFAULT_PAGE_SIZE;
  const openInNewTab = clientSettings.values.openInNewTab !== false;
  const searchMode = String(clientSettings.values.searchMode ?? 'balanced');
  const typoCorrection = clientSettings.values.typoCorrection !== false;
  const queryExpansion = clientSettings.values.queryExpansion !== false;
  const prefixMatch = clientSettings.values.prefixMatch !== false;
  const directAnswers = health?.answer.autoAnswer ?? true;
  const citationsVisible = clientSettings.values.citationsVisible !== false;
  const region = clientSettings.values.region;
  const freshness = clientSettings.values.freshness === true;

  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [activeSource, setActiveSource] = useState<string | undefined>();
  const [sort, setSort] = useState<SearchSort>(freshness ? 'newest' : 'relevance');
  const [forceWeb, setForceWeb] = useState(false);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<UniversalQueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const query = useDebounced(input, 400);
  const answerQuery = useDebounced(input.trim(), 900);
  const historyQuery = useDebounced(input.trim(), 1500);
  const abortRef = useRef<AbortController | null>(null);
  const lastRecordedRef = useRef<string | null>(null);

  const suggestQuery = useDebounced(input, 120);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);

  const answersEnabled = health?.answer.enabled ?? false;
  const [answer, setAnswer] = useState<AnswerResponse | null>(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [answerRequested, setAnswerRequested] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceNote, setSourceNote] = useState<string | null>(null);
  const [addingSource, setAddingSource] = useState(false);
  const answerAbort = useRef<AbortController | null>(null);

  const runAnswer = useCallback((q: string, fresh: boolean, urls?: string[]) => {
    answerAbort.current?.abort();
    const controller = new AbortController();
    answerAbort.current = controller;
    setAnswerRequested(true);
    setAnswerLoading(true);
    setAnswerError(null);
    api
      .answer(q, fresh, controller.signal, fresh ? undefined : urls)
      .then((res) => {
        setAnswer(res);
        setAnswerError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setAnswerError(err instanceof Error ? err.message : 'Answer failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setAnswerLoading(false);
      });
  }, []);

  const synthesis = result && result.query === answerQuery ? result.synthesis : null;
  const citedUrls =
    result && result.query === answerQuery
      ? result.results.map((hit) => hit.url).filter((url): url is string => Boolean(url))
      : [];

  useEffect(() => {
    answerAbort.current?.abort();
    setAnswer(null);
    setAnswerError(null);
    setAnswerRequested(false);
    setAnswerLoading(false);
    if (!answersEnabled || !directAnswers || !answerQuery || synthesis !== 'possible') return;
    runAnswer(answerQuery, false, citedUrls);
    // citedUrls is derived from `result`; depending on the array identity would refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerQuery, synthesis, answersEnabled, directAnswers, result, runAnswer]);

  const freshnessWas = useRef(freshness);
  useEffect(() => {
    if (freshnessWas.current === freshness) return;
    freshnessWas.current = freshness;
    setSort((current) => {
      if (freshness) return 'newest';
      return current === 'newest' ? 'relevance' : current;
    });
  }, [freshness]);

  useEffect(() => {
    setForceWeb(false);
  }, [query]);

  useEffect(() => {
    setPage(0);
  }, [
    query,
    activeTags,
    activeSource,
    sort,
    searchMode,
    typoCorrection,
    queryExpansion,
    prefixMatch,
    forceWeb,
  ]);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    api
      .query(
        {
          q: query,
          limit: resultsPerPage,
          offset: page * resultsPerPage,
          tags: activeTags,
          source: activeSource,
          sort,
          combineWith: searchMode === 'precise' ? 'AND' : searchMode === 'broad' ? 'OR' : undefined,
          allowPartialMatch: searchMode === 'precise' ? false : queryExpansion,
          fuzzy: typoCorrection,
          prefix: prefixMatch,
          web: forceWeb ? 'force' : undefined,
        },
        controller.signal,
      )
      .then((res) => {
        setResult(res);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Search failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    query,
    page,
    activeTags,
    sort,
    resultsPerPage,
    searchMode,
    typoCorrection,
    queryExpansion,
    prefixMatch,
    activeSource,
    forceWeb,
    retryNonce,
  ]);

  useEffect(() => {
    const q = historyQuery.trim();
    if (!q || q === lastRecordedRef.current) return;
    lastRecordedRef.current = q;
    onCommit(q, result && result.query === q ? result.kind : 'default');
  }, [historyQuery, result, onCommit]);

  useEffect(() => {
    const q = suggestQuery.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    api
      .suggest(q, controller.signal)
      .then((res) =>
        setSuggestions(res.suggestions.filter((s) => s.toLowerCase() !== q.toLowerCase())),
      )
      .catch(() => {
        /* suggestions are a convenience; ignore failures */
      });
    return () => controller.abort();
  }, [suggestQuery]);

  useEffect(() => {
    setActiveSuggestion(-1);
  }, [suggestions]);

  const pickSuggestion = (s: string) => {
    onInputChange(s);
    setSuggestOpen(false);
    setActiveSuggestion(-1);
  };

  const local = result?.local ?? null;
  const hits = result?.results ?? [];
  const totalPages = result ? Math.max(1, Math.ceil(result.total / resultsPerPage)) : 1;
  const facetTags = useMemo(
    () =>
      local
        ? Object.entries(local.facets.tags)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
        : [],
    [local],
  );

  const facetSources = useMemo(
    () =>
      local
        ? Object.entries(local.facets.sources)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
        : [],
    [local],
  );

  const toggleTag = (tag: string) =>
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const chooseSort = (next: SearchSort) => {
    setSort(next);
    const wantFresh = next === 'newest';
    if (freshness !== wantFresh) clientSettings.setValue('freshness', wantFresh);
  };

  const hasFilters =
    (result?.total ?? 0) > 1 ||
    activeTags.length > 0 ||
    Boolean(activeSource) ||
    facetTags.length > 0 ||
    facetSources.length > 0;
  const answerHasProse = Boolean(
    answer &&
    (answer.confidence !== 'none' ||
      (answer.candidates?.length ?? 0) > 0 ||
      answer.claims.length > 0),
  );
  const showEmpty = Boolean(
    result && query.trim() && hits.length === 0 && !loading && !result.primary,
  );
  const showReady = Boolean(result && !query.trim() && hits.length === 0 && !loading);

  const runAction = (action: SearchAction) => {
    if (action.id === 'add') {
      setAddOpen(true);
      setSourceNote(null);
      return;
    }
    if (!action.query) return;
    if (action.id === 'web' && action.query === query.trim()) {
      setForceWeb(true);
      setRetryNonce((n) => n + 1);
      return;
    }
    onInputChange(action.query);
  };

  const submitSource = (event: React.FormEvent) => {
    event.preventDefault();
    const url = sourceUrl.trim();
    if (!url) return;
    setAddingSource(true);
    setSourceNote(null);
    api
      .crawl({ url, maxPages: 1 })
      .then((res) => {
        setSourceNote(
          res.documentsIndexed > 0
            ? `Indexed ${res.documentsIndexed} page from that URL.`
            : 'The URL was fetched but no page was indexed.',
        );
        setSourceUrl('');
        setRetryNonce((n) => n + 1);
      })
      .catch((err: unknown) =>
        setSourceNote(err instanceof Error ? err.message : 'Could not add that URL.'),
      )
      .finally(() => setAddingSource(false));
  };
  return (
    <section className="search">
      <div className="search__box">
        <input
          type="search"
          autoFocus
          placeholder="Search anything…"
          value={input}
          onChange={(event) => {
            onInputChange(event.target.value);
            setSuggestOpen(true);
          }}
          onFocus={() => setSuggestOpen(true)}
          onBlur={() => setTimeout(() => setSuggestOpen(false), 120)}
          onKeyDown={(event) => {
            const open = suggestOpen && suggestions.length > 0;
            if (event.key === 'Escape') {
              setSuggestOpen(false);
              setActiveSuggestion(-1);
            } else if (event.key === 'ArrowDown') {
              if (!open) return;
              event.preventDefault();
              setActiveSuggestion((i) => (i + 1) % suggestions.length);
            } else if (event.key === 'ArrowUp') {
              if (!open) return;
              event.preventDefault();
              setActiveSuggestion((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
            } else if (event.key === 'Enter') {
              const chosen = open ? suggestions[activeSuggestion] : undefined;
              if (!chosen) return;
              event.preventDefault();
              pickSuggestion(chosen);
            }
          }}
          aria-label="Search query"
          aria-autocomplete="list"
          role="combobox"
          aria-expanded={suggestOpen && suggestions.length > 0}
          aria-controls="search-suggest-list"
          aria-activedescendant={
            activeSuggestion >= 0 ? `search-suggest-${activeSuggestion}` : undefined
          }
        />
        {input && (
          <button
            type="button"
            className="search__clear"
            onClick={() => onInputChange('')}
            aria-label="Clear search"
          >
            clear
          </button>
        )}
        {suggestOpen && input.trim().length >= 2 && suggestions.length > 0 && (
          <ul className="suggest" role="listbox" id="search-suggest-list">
            {suggestions.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  id={`search-suggest-${i}`}
                  role="option"
                  aria-selected={i === activeSuggestion}
                  className={i === activeSuggestion ? 'active' : undefined}
                  onMouseEnter={() => setActiveSuggestion(i)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pickSuggestion(s);
                  }}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="notice notice--error">{error}</p>}

      {result?.primary && <PrimaryCard primary={result.primary} />}

      {answersEnabled &&
        answerQuery &&
        synthesis === 'possible' &&
        !directAnswers &&
        !answerRequested && (
          <button
            type="button"
            className="answer__cta"
            onClick={() => runAnswer(answerQuery, false, citedUrls)}
          >
            ↳ weave an answer for “{answerQuery}”
          </button>
        )}

      {loading && query.trim() && (
        <p className="search__status">Searching web and connected sources…</p>
      )}

      {answerError && answerRequested && (
        <p className="notice">Couldn’t write a summary. Results are listed separately.</p>
      )}

      {answerRequested && answerHasProse && (
        <AnswerCard
          data={answer}
          loading={answerLoading}
          citationsVisible={citationsVisible}
          region={region}
          onRefresh={() => runAnswer(answerQuery || query, true)}
        />
      )}

      {!loading && answerLoading && hits.length > 0 && (
        <p className="search__status">Checking whether these results support a summary…</p>
      )}

      {!answerLoading &&
        ((hits.length > 0 && answer && !answerHasProse) ||
          (synthesis === 'insufficient' && !answerRequested)) && (
          <p className="search__summary-note">
            Results found for “{query.trim()}”, but there isn’t enough evidence to write a summary.
          </p>
        )}

      {result && query.trim() && !loading && (
        <p className="search__meta">
          <strong>{formatCount(result.total, region)}</strong> result{result.total === 1 ? '' : 's'}
          {result.query ? ` for “${result.query}”` : ''}
          {' · '}
          {result.tookMs} ms
          {result.intent !== 'general' ? ` · ${result.intent}` : ''}
          {hasFilters && (
            <button
              type="button"
              className="search__filters-toggle"
              onClick={() => setFiltersOpen((o) => !o)}
            >
              filters {filtersOpen ? '▴' : '▾'}
            </button>
          )}
        </p>
      )}

      {filtersOpen && hasFilters && (
        <div className="filters">
          {(result?.total ?? 0) > 1 && (
            <label className="search__sort">
              sort
              <select
                value={sort}
                onChange={(event) => chooseSort(event.target.value as SearchSort)}
              >
                {SORT_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {activeTags.length > 0 && (
            <div className="chips">
              {activeTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="chip chip--active"
                  onClick={() => toggleTag(tag)}
                >
                  {tag} ✕
                </button>
              ))}
            </div>
          )}

          {facetTags.length > 0 && (
            <div className="chips chips--facets">
              {facetTags.map(([tag, count]) => (
                <button
                  key={tag}
                  type="button"
                  className={activeTags.includes(tag) ? 'chip chip--active' : 'chip'}
                  onClick={() => toggleTag(tag)}
                >
                  {tag} <span className="chip__count">{count}</span>
                </button>
              ))}
            </div>
          )}

          {facetSources.length > 0 && (
            <div className="chips chips--facets">
              {facetSources.map(([source, count]) => (
                <button
                  key={source}
                  type="button"
                  className={activeSource === source ? 'chip chip--active' : 'chip'}
                  onClick={() => setActiveSource((prev) => (prev === source ? undefined : source))}
                >
                  {source} <span className="chip__count">{count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <ol className="results">
        {hits.map((hit) => (
          <li key={hit.id} className="result">
            <h3 className="result__title">
              {hit.url ? (
                <a href={hit.url} target={openInNewTab ? '_blank' : undefined} rel="noreferrer">
                  <span dangerouslySetInnerHTML={{ __html: hit.title }} />
                </a>
              ) : (
                <span dangerouslySetInnerHTML={{ __html: hit.title }} />
              )}
            </h3>
            {(hit.domain || hit.url) && <div className="result__url">{hit.domain || hit.url}</div>}
            {hit.snippet && (
              <p className="result__snippet" dangerouslySetInnerHTML={{ __html: hit.snippet }} />
            )}
            <div className="result__foot">
              <span className="result__source" data-score={hit.score}>
                {hit.origin === 'web' ? 'web' : 'index'} · {hit.provider}
              </span>
              {hit.updatedAt && <span>{relativeTime(hit.updatedAt, region)}</span>}
              {hit.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="chip chip--sm"
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ol>

      {(showEmpty || (!answerLoading && hits.length > 0 && answer && !answerHasProse)) &&
        result && (
          <div className={showEmpty ? 'empty empty--quiet' : 'search__actions'}>
            {showEmpty && (
              <>
                <strong>No strong matches found for “{query.trim()}”.</strong>
                <span>
                  {result.outcome === 'unconfigured'
                    ? 'Web search is not set up on this server.'
                    : `Searched ${result.attempted.join(', ')}.`}
                </span>
              </>
            )}
            <div className="empty__actions">
              {result.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="chip"
                  onClick={() => runAction(action)}
                >
                  {action.label}
                </button>
              ))}
            </div>
            {(addOpen || showEmpty) && (
              <form className="empty__add" onSubmit={submitSource}>
                <input
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  type="url"
                  placeholder="https://… add a source URL"
                  aria-label="Source URL"
                />
                <button
                  type="submit"
                  className="btn"
                  disabled={addingSource || sourceUrl.trim() === ''}
                >
                  {addingSource ? 'Adding…' : 'Add'}
                </button>
              </form>
            )}
            {sourceNote && <span>{sourceNote}</span>}
            {local?.suggestion && (
              <button
                type="button"
                className="chip"
                onClick={() => onInputChange(local.suggestion!)}
              >
                Try “{local.suggestion}”
              </button>
            )}
          </div>
        )}

      {showReady && (
        <div className="empty">
          <Beacon size={150} />
          <strong>ready</strong>
          <span>Type to search — a name, a domain, a question, or plain text.</span>
        </div>
      )}

      {result && query.trim() && (
        <details className="devdetails">
          <summary>Search details</summary>
          {result.queriesTried.length > 0 && <p>Tried {result.queriesTried.join(' → ')}</p>}
          <ul>
            {result.diagnostics.map((item) => (
              <li key={item.id}>
                {item.label}: {item.status}
                {item.detail ? ` — ${item.detail}` : ''}
                {item.missingEnv.length > 0 ? ` — set ${item.missingEnv.join(', ')}` : ''}
                {item.tookMs != null ? ` — ${item.tookMs} ms` : ''}
              </li>
            ))}
          </ul>
          {answer && (
            <p>
              Summary:{' '}
              {answer.synthesizer === 'extractive'
                ? 'extractive, no model configured'
                : answer.synthesizer}
              {answer.tookMs ? ` — ${Math.round(answer.tookMs)} ms` : ''}
              {answer.generatedAt ? ` — ${relativeTime(answer.generatedAt, region)}` : ''}
            </p>
          )}
        </details>
      )}

      {result && result.total > resultsPerPage && (
        <div className="pager">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ← Previous
          </button>
          <span>
            Page {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </section>
  );
}

// --- Adaptive result cards ----------------------------------------------------
// The universal box can return a structured "primary" result shaped like what
// it actually is, rather than forcing every answer through the same
// title/url/snippet template.

function PrimaryCard({ primary }: { primary: PrimaryResult }): JSX.Element {
  switch (primary.kind) {
    case 'domain':
      return <DomainCard primary={primary} />;
    case 'ip':
      return <IpCard primary={primary} />;
    case 'calculation':
      return <CalculationCard primary={primary} />;
    case 'plate':
      return <PlateSearchCard initial={primary.data} />;
  }
}

function DomainCard({ primary }: { primary: DomainPrimary }): JSX.Element {
  const data = primary.data;
  return (
    <section className="primary-card primary-card--domain">
      <div className="primary-card__head">
        <span className="primary-card__tag">DOMAIN</span>
        <strong className="primary-card__title">{primary.domain}</strong>
      </div>
      {!primary.enabled && (
        <p className="notice">
          Domain lookups are disabled on this server (<code>BEACON_LOOKUPS_ENABLED=false</code>).
        </p>
      )}
      {data && (
        <>
          <dl className="kv">
            {data.addresses.length > 0 && (
              <div>
                <dt>IPv4</dt>
                <dd>{data.addresses.join(', ')}</dd>
              </div>
            )}
            {data.ipv6Addresses.length > 0 && (
              <div>
                <dt>IPv6</dt>
                <dd>{data.ipv6Addresses.join(', ')}</dd>
              </div>
            )}
            {data.nameservers.length > 0 && (
              <div>
                <dt>Nameservers</dt>
                <dd>{data.nameservers.join(', ')}</dd>
              </div>
            )}
            {data.mailExchanges.length > 0 && (
              <div>
                <dt>Mail (MX)</dt>
                <dd>{data.mailExchanges.join(', ')}</dd>
              </div>
            )}
            {data.registrar && (
              <div>
                <dt>Registrar</dt>
                <dd>{data.registrar}</dd>
              </div>
            )}
            {data.createdDate && (
              <div>
                <dt>Registered</dt>
                <dd>{data.createdDate.slice(0, 10)}</dd>
              </div>
            )}
            {data.expiresDate && (
              <div>
                <dt>Expires</dt>
                <dd>{data.expiresDate.slice(0, 10)}</dd>
              </div>
            )}
          </dl>
          {data.notices.length > 0 && (
            <ul className="primary-card__notices">
              {data.notices.map((notice, i) => (
                <li key={i}>{notice}</li>
              ))}
            </ul>
          )}
          <p className="primary-card__sources">Sources: DNS · RDAP</p>
        </>
      )}
    </section>
  );
}

function IpCard({ primary }: { primary: IpPrimary }): JSX.Element {
  const data = primary.data;
  return (
    <section className="primary-card primary-card--ip">
      <div className="primary-card__head">
        <span className="primary-card__tag">IP ADDRESS</span>
        <strong className="primary-card__title">{primary.ip}</strong>
      </div>
      {!primary.enabled && (
        <p className="notice">
          IP lookups are disabled on this server (<code>BEACON_LOOKUPS_ENABLED=false</code>).
        </p>
      )}
      {data && (
        <>
          <dl className="kv">
            {data.organization && (
              <div>
                <dt>Organization</dt>
                <dd>{data.organization}</dd>
              </div>
            )}
            {data.network && (
              <div>
                <dt>Network</dt>
                <dd>{data.network}</dd>
              </div>
            )}
            {data.country && (
              <div>
                <dt>Country</dt>
                <dd>{data.country}</dd>
              </div>
            )}
            {data.reverseDns.length > 0 && (
              <div>
                <dt>Reverse DNS</dt>
                <dd>{data.reverseDns.join(', ')}</dd>
              </div>
            )}
            {data.rdapHandle && (
              <div>
                <dt>RDAP handle</dt>
                <dd>{data.rdapHandle}</dd>
              </div>
            )}
          </dl>
          {data.notices.length > 0 && (
            <ul className="primary-card__notices">
              {data.notices.map((notice, i) => (
                <li key={i}>{notice}</li>
              ))}
            </ul>
          )}
          <p className="primary-card__sources">Sources: Reverse DNS · RDAP</p>
        </>
      )}
    </section>
  );
}

function CalculationCard({ primary }: { primary: CalculationPrimary }): JSX.Element {
  return (
    <section className="primary-card primary-card--calculation">
      <div className="primary-card__head">
        <span className="primary-card__tag">CALCULATION</span>
      </div>
      {primary.error ? (
        <p className="notice notice--error">{primary.error}</p>
      ) : (
        <p className="primary-card__result">
          {primary.expression} = <strong>{primary.result}</strong>
        </p>
      )}
    </section>
  );
}

// --- History -------------------------------------------------------------

function HistoryView({
  entries,
  region,
  onPick,
  onClear,
}: {
  entries: HistoryEntry[];
  region: unknown;
  onPick: (query: string) => void;
  onClear: () => void;
}): JSX.Element {
  return (
    <section className="history">
      <div className="history__actions">
        <p className="notice">Recent queries, stored locally in this browser.</p>
        {entries.length > 0 && (
          <button type="button" className="btn btn--danger" onClick={onClear}>
            clear history
          </button>
        )}
      </div>

      {entries.length > 0 ? (
        <ul className="history__list">
          {entries.map((entry, i) => (
            <li key={`${entry.query}-${i}`} className="history__row">
              <button type="button" className="history__query" onClick={() => onPick(entry.query)}>
                {entry.query}
              </button>
              <span className="history__kind">{KIND_LABEL[entry.kind]}</span>
              <span className="history__time">{relativeTime(entry.at, region)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty">
          <Beacon size={120} />
          <strong>no history yet</strong>
          <span>Queries you run will show up here.</span>
        </div>
      )}
    </section>
  );
}

function LibraryView({
  onDone,
  pageSize,
  region,
}: {
  onDone: () => void;
  pageSize: number;
  region: unknown;
}): JSX.Element {
  const [docs, setDocs] = useState<BeaconDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'add' | 'edit' | 'crawl' | 'import' | null>(null);
  const [editing, setEditing] = useState<BeaconDocument | null>(null);
  const [detail, setDetail] = useState<BeaconDocument | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .documents({ limit: pageSize, offset: page * pageSize })
      .then((res) => {
        setDocs(res.documents);
        setTotal(res.total);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Failed to load documents'),
      )
      .finally(() => setLoading(false));
  }, [page, pageSize]);

  useEffect(refresh, [refresh]);

  const handleAdded = () => {
    setPanel(null);
    setPage(0);
    refresh();
    onDone();
  };

  const remove = (doc: BeaconDocument) => {
    if (!window.confirm(`Remove "${doc.title}" from the index?`)) return;
    api
      .deleteDocument(doc.id)
      .then(() => {
        refresh();
        onDone();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to remove'));
  };

  const clearAll = () => {
    if (!window.confirm(`Remove all ${total.toLocaleString()} documents from the index?`)) return;
    api
      .clearIndex()
      .then(() => {
        setPage(0);
        refresh();
        onDone();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to clear'));
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const openDetail = (id: string) => {
    api
      .document(id)
      .then((doc) => {
        setDetail(doc);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  };

  const startEdit = (doc: BeaconDocument) => {
    setEditing(doc);
    setPanel('edit');
  };

  return (
    <section className="library">
      <h2>Indexed documents</h2>
      <div className="library__actions">
        <button
          type="button"
          className={panel === 'add' ? 'btn btn--active' : 'btn'}
          onClick={() => setPanel((p) => (p === 'add' ? null : 'add'))}
        >
          + add document
        </button>
        <button
          type="button"
          className={panel === 'import' ? 'btn btn--active' : 'btn'}
          onClick={() => setPanel((p) => (p === 'import' ? null : 'import'))}
        >
          ↑ import json
        </button>
        <button
          type="button"
          className={panel === 'crawl' ? 'btn btn--active' : 'btn'}
          onClick={() => setPanel((p) => (p === 'crawl' ? null : 'crawl'))}
        >
          ⤓ crawl site
        </button>
        {total > 0 && (
          <button type="button" className="btn btn--danger" onClick={clearAll}>
            clear index
          </button>
        )}
      </div>

      {panel === 'add' && <AddView onDone={handleAdded} />}
      {panel === 'edit' && editing && (
        <AddView
          initial={editing}
          onDone={() => {
            setEditing(null);
            handleAdded();
          }}
        />
      )}
      {panel === 'import' && <ImportView onDone={handleAdded} />}
      {panel === 'crawl' && <CrawlView onDone={handleAdded} />}
      {detail && (
        <article className="library__detail">
          <div className="library__actions">
            <strong>{detail.title}</strong>
            <span>{detail.id}</span>
            <button type="button" className="btn" onClick={() => startEdit(detail)}>
              edit
            </button>
            <button type="button" className="btn" onClick={() => setDetail(null)}>
              close
            </button>
          </div>
          {detail.source && <p className="notice">Source: {detail.source}</p>}
          <p className="answer__quote">{detail.body || '(empty body)'}</p>
        </article>
      )}

      {error && <p className="notice notice--error">{error}</p>}

      <p className="search__meta">
        <strong>{formatCount(total, region)}</strong> document{total === 1 ? '' : 's'} indexed
        {loading && (
          <>
            {' · '}
            <span className="search__updating" aria-hidden /> loading
          </>
        )}
      </p>

      {docs.length > 0 ? (
        <ul className="library__list">
          {docs.map((doc) => (
            <li key={doc.id} className="library__row">
              <div className="library__row-main">
                <strong className="library__row-title">
                  {doc.url ? (
                    <a href={doc.url} target="_blank" rel="noreferrer">
                      {doc.title}
                    </a>
                  ) : (
                    doc.title
                  )}
                </strong>
                <div className="library__row-meta">
                  <span>{doc.id}</span>
                  {doc.source && <span>{doc.source}</span>}
                  {doc.tags.length > 0 && <span>{doc.tags.join(', ')}</span>}
                  <span>{relativeTime(doc.updatedAt, region)}</span>
                </div>
              </div>
              <button type="button" className="library__remove" onClick={() => openDetail(doc.id)}>
                view
              </button>
              <button type="button" className="library__remove" onClick={() => startEdit(doc)}>
                edit
              </button>
              <button
                type="button"
                className="library__remove"
                onClick={() => remove(doc)}
                aria-label={`Remove ${doc.title}`}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !loading && (
          <div className="empty">
            <Beacon size={120} />
            <strong>index empty</strong>
            <span>Add a document or crawl a site to get started.</span>
          </div>
        )
      )}

      {total > pageSize && (
        <div className="pager">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ← Previous
          </button>
          <span>
            Page {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </section>
  );
}

const CONFIDENCE_LABEL: Record<AnswerConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  none: 'No summary',
};

function ConfidenceBadge({ confidence }: { confidence: AnswerConfidence }): JSX.Element {
  const cls =
    confidence === 'high' || confidence === 'medium'
      ? 'badge badge--ok'
      : confidence === 'low'
        ? 'badge badge--warn'
        : 'badge badge--muted';
  return <span className={cls}>{CONFIDENCE_LABEL[confidence]}</span>;
}

const MATCH_LABEL: Partial<Record<EntityMatchType, string>> = {
  exact: 'Exact name match',
  partial: 'Possible match',
  different: 'Different entity',
  topical: 'Related topic',
};

/** A source's subject-match label is a separate signal from its trust/reliability — never collapse the two. */
function sourceMatchLabel(source: AnswerSource): string | undefined {
  const byMatch = MATCH_LABEL[source.matchType];
  if (byMatch) return byMatch;
  if (!source.usedInAnswer) return 'Low content quality';
  return undefined;
}

function AnswerCard({
  data,
  loading,
  citationsVisible,
  region,
  onRefresh,
}: {
  data: AnswerResponse | null;
  loading: boolean;
  citationsVisible: boolean;
  region: unknown;
  onRefresh: () => void;
}): JSX.Element {
  const cite = (id: number) =>
    citationsVisible ? (
      <a key={id} href={`#answer-src-${id}`} className="cite">
        [{id}]
      </a>
    ) : null;
  return (
    <section
      className="answer"
      aria-busy={loading}
      aria-label={data ? `Answer for ${data.query}` : 'Answer'}
    >
      <div className="answer__head">
        <span className="answer__tag">ANSWER</span>
        {data && <ConfidenceBadge confidence={data.confidence} />}
        {data?.cached && <span className="badge badge--muted">cached</span>}
        {loading && <span className="search__updating" aria-hidden />}
        <span className="answer__spacer" />
        {data && (
          <button type="button" className="answer__refresh" onClick={onRefresh}>
            re-run
          </button>
        )}
      </div>

      {!data && loading && <p className="answer__body answer__body--wait">weaving an answer…</p>}

      {data && (
        <>
          <p className="answer__reason">{data.confidenceReason}</p>
          <p className="answer__reason">
            identity {Math.round(data.identityConfidence * 100)}% · source quality{' '}
            {Math.round(data.sourceQuality * 100)}%{data.cached ? ' · cached' : ''}
          </p>
          {data.warnings.length > 0 && (
            <ul className="answer__gaps">
              {data.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}

          {data.candidates && data.candidates.length > 0 ? (
            <>
              <p className="answer__body">{data.answer}</p>
              <ol className="answer__candidates">
                {data.candidates.map((candidate, i) => (
                  <li key={i} className="answer__candidate">
                    <div className="answer__candidate-head">
                      <strong>{candidate.label}</strong>
                      {MATCH_LABEL[candidate.matchType] && (
                        <span className={`match match--${candidate.matchType}`}>
                          {MATCH_LABEL[candidate.matchType]}
                        </span>
                      )}
                    </div>
                    <p className="answer__candidate-summary">
                      {citationsVisible ? candidate.summary : stripCitations(candidate.summary)}{' '}
                      {candidate.sourceIds.map((id) => cite(id))}
                    </p>
                  </li>
                ))}
              </ol>
            </>
          ) : data.claims.length > 0 ? (
            <p className="answer__body">
              {data.claims.map((claim, i) => (
                <span key={i} className={claim.supported ? 'claim' : 'claim claim--unverified'}>
                  {citationsVisible ? claim.text : stripCitations(claim.text)}{' '}
                  {claim.sourceIds.map((id) => cite(id))}
                  {!claim.supported && <span className="claim__flag">unverified</span>}{' '}
                </span>
              ))}
            </p>
          ) : (
            <p className="answer__body">{data.answer}</p>
          )}

          {data.disclaimer && <p className="answer__disclaimer">⚠ {data.disclaimer}</p>}

          {data.searchGaps.length > 0 && (
            <div className="answer__gaps">
              <span className="answer__gaps-tag">Search gaps</span>
              <ul>
                {data.searchGaps.map((gap, i) => (
                  <li key={i}>{gap}</li>
                ))}
              </ul>
            </div>
          )}

          {data.sources.length > 0 && (
            <ol className="answer__sources">
              {data.sources.map((source) => (
                <li key={source.id} id={`answer-src-${source.id}`} className="answer__source">
                  <div className="answer__source-head">
                    <span className="answer__source-n">[{source.id}]</span>
                    {source.url ? (
                      <a href={source.url} target="_blank" rel="noreferrer">
                        {source.title}
                      </a>
                    ) : (
                      <span>{source.title}</span>
                    )}
                  </div>
                  <div className="answer__source-meta">
                    {sourceMatchLabel(source) && (
                      <span className={`match match--${source.matchType}`}>
                        {sourceMatchLabel(source)}
                      </span>
                    )}
                    <span className={`trust trust--${source.trust}`}>
                      {TRUST_LABEL[source.trust]}
                    </span>
                    <span>{source.origin}</span>
                    {source.domain && <span>{source.domain}</span>}
                    <span>
                      {source.live ? 'fetched ' : 'indexed '}
                      {relativeTime(source.retrievedAt, region)}
                    </span>
                  </div>
                  <div className="answer__source-why">{source.trustReason}</div>
                  <p className="answer__quote">“{source.quote}”</p>
                </li>
              ))}
            </ol>
          )}

          {data.confidence !== 'none' && (
            <p className="answer__foot">
              {data.sources.length} source{data.sources.length === 1 ? '' : 's'}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function AddView({
  onDone,
  initial,
}: {
  onDone: () => void;
  initial?: BeaconDocument;
}): JSX.Element {
  const [docId, setDocId] = useState(initial?.id ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [source, setSource] = useState(initial?.source ?? '');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const parsedTags = tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    const payload = {
      title: title.trim(),
      body,
      url: url.trim() || undefined,
      source: source.trim() || undefined,
      tags: parsedTags,
    };
    const request = initial
      ? api.updateDocument(initial.id, payload)
      : api.addDocument({ ...payload, id: docId.trim() || undefined });
    request
      .then((doc) => {
        setStatus({ kind: 'ok', text: `Indexed "${doc.title}" (id: ${doc.id})` });
        if (!initial) {
          setDocId('');
          setTitle('');
          setBody('');
          setUrl('');
          setSource('');
          setTags('');
        }
        onDone();
      })
      .catch((err: unknown) =>
        setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Failed' }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <form className="form" onSubmit={submit}>
      <label>
        Id {initial ? '' : '(optional, stable across re-adds)'}
        <input
          value={initial ? initial.id : docId}
          onChange={(e) => setDocId(e.target.value)}
          readOnly={Boolean(initial)}
          maxLength={512}
        />
      </label>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={1024} />
      </label>
      <label>
        Source (optional)
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="handbook"
          maxLength={256}
        />
      </label>
      <label>
        URL (optional)
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          type="url"
          placeholder="https://…"
        />
      </label>
      <label>
        Tags (comma-separated)
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="docs, guide" />
      </label>
      <label>
        Body
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} />
      </label>
      <button type="submit" className="btn" disabled={busy || title.trim() === ''}>
        {busy ? 'Indexing…' : initial ? 'Save changes' : 'Add to index'}
      </button>
      {status && (
        <p className={status.kind === 'ok' ? 'notice notice--ok' : 'notice notice--error'}>
          {status.text}
        </p>
      )}
    </form>
  );
}

function ImportView({ onDone }: { onDone: () => void }): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    let documents: unknown[];
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) documents = parsed;
      else if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { documents?: unknown }).documents)
      ) {
        documents = (parsed as { documents: unknown[] }).documents;
      } else {
        throw new Error(
          'Expected a JSON array or { "documents": [...] }, the same shape the CLI imports.',
        );
      }
    } catch (err) {
      setBusy(false);
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Invalid JSON' });
      return;
    }
    api
      .bulkImport(documents)
      .then((res) => {
        setStatus({
          kind: 'ok',
          text: `Indexed ${res.indexed} document${res.indexed === 1 ? '' : 's'}.`,
        });
        setText('');
        onDone();
      })
      .catch((err: unknown) =>
        setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Import failed' }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <form className="form" onSubmit={submit}>
      <p className="notice">
        Paste the same JSON <code>beacon import</code> accepts: an array of documents, or{' '}
        <code>{'{ "documents": [ ... ] }'}</code>. Each item may set <code>id</code>,{' '}
        <code>title</code>, <code>body</code>, <code>url</code>, <code>tags</code>, and{' '}
        <code>source</code>.
      </p>
      <label>
        JSON
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} required />
      </label>
      <button type="submit" className="btn" disabled={busy || text.trim() === ''}>
        {busy ? 'Importing…' : 'Import'}
      </button>
      {status && (
        <p className={status.kind === 'ok' ? 'notice notice--ok' : 'notice notice--error'}>
          {status.text}
        </p>
      )}
    </form>
  );
}

function CrawlView({ onDone }: { onDone: () => void }): JSX.Element {
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState('25');
  const [tags, setTags] = useState('');
  const [sameOriginOnly, setSameOriginOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [report, setReport] = useState<{
    errors: Array<{ url: string; error: string }>;
    skipped: Array<{ url: string; reason: string }>;
  } | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    setReport(null);
    api
      .crawl({
        url: url.trim(),
        maxPages: Number(maxPages) || undefined,
        sameOriginOnly,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      })
      .then((res) => {
        setReport({ errors: res.errors, skipped: res.skipped });
        setStatus({
          kind: 'ok',
          text: `Crawled ${res.pagesCrawled} pages, indexed ${res.documentsIndexed}, ${res.errors.length} errors, ${res.skipped.length} skipped.`,
        });
        onDone();
      })
      .catch((err: unknown) =>
        setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Crawl failed' }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <form className="form" onSubmit={submit}>
      <p className="notice">
        Fetches HTML pages starting from a URL and indexes the text. Respects{' '}
        <code>robots.txt</code>. Large crawls can take a while — the request completes when the
        crawl finishes.
      </p>
      <label>
        Start URL
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          type="url"
          required
          placeholder="https://example.com"
        />
      </label>
      <label>
        Max pages
        <input
          value={maxPages}
          onChange={(e) => setMaxPages(e.target.value)}
          type="number"
          min={1}
          max={2000}
        />
      </label>
      <label>
        Tags (comma-separated)
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="website" />
      </label>
      <label>
        <input
          type="checkbox"
          checked={sameOriginOnly}
          onChange={(e) => setSameOriginOnly(e.target.checked)}
        />{' '}
        Same origin only
      </label>
      <button type="submit" className="btn" disabled={busy || url.trim() === ''}>
        {busy ? 'Crawling…' : 'Start crawl'}
      </button>
      {status && (
        <p className={status.kind === 'ok' ? 'notice notice--ok' : 'notice notice--error'}>
          {status.text}
        </p>
      )}
      {report && report.errors.length > 0 && (
        <ul className="answer__gaps">
          {report.errors.map((item) => (
            <li key={item.url}>
              {item.url}: {item.error}
            </li>
          ))}
        </ul>
      )}
      {report && report.skipped.length > 0 && (
        <ul className="answer__gaps">
          {report.skipped.map((item) => (
            <li key={`${item.url}-${item.reason}`}>
              skipped {item.url}: {item.reason}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

const STATUS_ICON: Record<string, string> = {
  pass: '[ ok ]',
  warn: '[warn]',
  fail: '[fail]',
  info: '[info]',
  skipped: '[skip]',
};

/** The plate-check report, shared by the advanced Settings tool and the universal box's plate card. */
function PlateReport({ report }: { report: PlateCheck }): JSX.Element {
  const badgeClass =
    report.summary.status === 'ok'
      ? 'badge badge--ok'
      : report.summary.status === 'attention'
        ? 'badge badge--warn'
        : 'badge badge--fail';

  return (
    <div className="plate__report">
      <div className="plate__headline">
        <span className={badgeClass}>{report.summary.status}</span>
        <div>
          <strong className="plate__mark">{report.formatted}</strong>
          <span className="plate__desc">{report.summary.headline}</span>
        </div>
      </div>

      <dl className="plate__facts">
        <div>
          <dt>Format</dt>
          <dd>{report.format}</dd>
        </div>
        {report.age && (
          <div>
            <dt>Age</dt>
            <dd>
              {report.age.description} (~{report.age.ageYears} yrs)
            </dd>
          </div>
        )}
        {report.region && (
          <div>
            <dt>Region</dt>
            <dd>
              {report.region.office}, {report.region.region} ({report.region.country})
            </dd>
          </div>
        )}
        {report.vehicle && (
          <div>
            <dt>Vehicle</dt>
            <dd>
              {[
                report.vehicle.colour,
                report.vehicle.make,
                report.vehicle.fuelType,
                report.vehicle.yearOfManufacture,
              ]
                .filter(Boolean)
                .join(' · ')}
            </dd>
          </div>
        )}
      </dl>

      <ul className="checks">
        {report.checks.map((check) => (
          <li key={check.id} className={`checks__item checks__item--${check.status}`}>
            <span className="checks__icon" aria-hidden>
              {STATUS_ICON[check.status] ?? '[ -- ]'}
            </span>
            <span className="checks__label">{check.label}</span>
            <span className="checks__detail">{check.detail}</span>
          </li>
        ))}
      </ul>

      {report.mot && report.mot.tests.length > 0 && (
        <details className="plate__mot">
          <summary>
            MOT history — {report.mot.totalTests} tests ({report.mot.passed} passed,{' '}
            {report.mot.failed} failed)
          </summary>
          <ul>
            {report.mot.tests.slice(0, 12).map((test, i) => (
              <li key={test.motTestNumber ?? i}>
                {test.completedDate?.slice(0, 10)} — <strong>{test.testResult}</strong>
                {typeof test.odometerValue === 'number'
                  ? ` · ${test.odometerValue.toLocaleString()} ${test.odometerUnit ?? ''}`
                  : ''}
                {test.defects.length > 0 ? ` · ${test.defects.length} defect(s)` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="plate__sources">Sources: {report.sources.join(', ')}</p>
    </div>
  );
}

function referenceIso(date: string): string | undefined {
  if (!date) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function PlateOptions({
  vehicle,
  mot,
  index,
  referenceDate,
  onVehicle,
  onMot,
  onIndex,
  onReferenceDate,
}: {
  vehicle: boolean;
  mot: boolean;
  index: boolean;
  referenceDate: string;
  onVehicle: (value: boolean) => void;
  onMot: (value: boolean) => void;
  onIndex: (value: boolean) => void;
  onReferenceDate: (value: string) => void;
}): JSX.Element {
  return (
    <div className="plate__opts">
      <label>
        <input type="checkbox" checked={vehicle} onChange={(e) => onVehicle(e.target.checked)} />{' '}
        DVLA vehicle data
      </label>
      <label>
        <input type="checkbox" checked={mot} onChange={(e) => onMot(e.target.checked)} /> MOT
        history
      </label>
      <label>
        <input type="checkbox" checked={index} onChange={(e) => onIndex(e.target.checked)} /> Save
        to index
      </label>
      <label>
        Reference date
        <input
          type="date"
          value={referenceDate}
          onChange={(e) => onReferenceDate(e.target.value)}
        />
      </label>
    </div>
  );
}

function PlateSearchCard({ initial }: { initial: PlateCheck }): JSX.Element {
  const [vehicle, setVehicle] = useState(true);
  const [mot, setMot] = useState(true);
  const [index, setIndex] = useState(false);
  const [referenceDate, setReferenceDate] = useState('');
  const [report, setReport] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReport(initial);
  }, [initial]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    api
      .checkPlate({
        plate: initial.input,
        vehicle,
        mot,
        index,
        referenceDate: referenceIso(referenceDate),
      })
      .then(setReport)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Check failed'))
      .finally(() => setBusy(false));
  };

  return (
    <section className="primary-card primary-card--plate">
      <form className="plate__form" onSubmit={submit}>
        <PlateOptions
          vehicle={vehicle}
          mot={mot}
          index={index}
          referenceDate={referenceDate}
          onVehicle={setVehicle}
          onMot={setMot}
          onIndex={setIndex}
          onReferenceDate={setReferenceDate}
        />
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Checking…' : 'Run checks'}
        </button>
      </form>
      {error && <p className="notice notice--error">{error}</p>}
      <PlateReport report={report} />
    </section>
  );
}

function PlateView({ onDone }: { onDone: () => void }): JSX.Element {
  const [input, setInput] = useState('');
  const [vehicle, setVehicle] = useState(true);
  const [mot, setMot] = useState(true);
  const [index, setIndex] = useState(false);
  const [referenceDate, setReferenceDate] = useState('');
  const [report, setReport] = useState<PlateCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    api
      .checkPlate({
        plate: input.trim(),
        vehicle,
        mot,
        index,
        referenceDate: referenceIso(referenceDate),
      })
      .then((res) => {
        setReport(res);
        if (index) onDone();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Check failed'))
      .finally(() => setBusy(false));
  };

  return (
    <section className="plate">
      <form className="plate__form" onSubmit={submit}>
        <input
          className="plate__input"
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          placeholder="AB12 CDE"
          aria-label="Registration mark"
          maxLength={16}
          autoFocus
        />
        <button type="submit" className="btn" disabled={busy || input.trim() === ''}>
          {busy ? 'Checking…' : 'Run checks'}
        </button>
      </form>
      <PlateOptions
        vehicle={vehicle}
        mot={mot}
        index={index}
        referenceDate={referenceDate}
        onVehicle={setVehicle}
        onMot={setMot}
        onIndex={setIndex}
        onReferenceDate={setReferenceDate}
      />

      {error && <p className="notice notice--error">{error}</p>}

      {report && <PlateReport report={report} />}
    </section>
  );
}

function DocsView(): JSX.Element {
  return (
    <section className="prose">
      <h2>About Beacon Search</h2>
      <p>
        Beacon Search is a small, dependency-light search engine you can run anywhere Node.js runs.
        It keeps a full-text index in memory (powered by MiniSearch) and persists it to a single
        JSON file — no database, no external services required for the core index.
      </p>
      <h3>The universal box</h3>
      <p>
        The <em>Search</em> tab is a single input. Alongside the usual local-index search, Beacon
        classifies what you typed and — when it recognises the shape — attaches a structured result:
        a bare domain resolves DNS + RDAP registration data, an IP resolves reverse DNS + RDAP
        network data, an arithmetic expression is evaluated directly, and{' '}
        <code>plate &lt;reg&gt;</code> runs the number plate checker. Everything else is just a
        search. Domain/IP lookups need no API key (DNS and RDAP are open internet infrastructure)
        but can be turned off entirely with <code>BEACON_LOOKUPS_ENABLED=false</code> for a fully
        offline deployment.
      </p>
      <h3>API</h3>
      <ul>
        <li>
          <code>GET /api/search?q=…&amp;tags=…&amp;limit=…&amp;offset=…</code>
        </li>
        <li>
          <code>GET /api/query?q=…</code> — same params as <code>/api/search</code>, plus the
          classified <code>primary</code> result
        </li>
        <li>
          <code>GET /api/documents</code> · <code>GET /api/documents/:id</code>
        </li>
        <li>
          <code>POST /api/documents</code> · <code>PUT /api/documents/:id</code> ·{' '}
          <code>DELETE /api/documents/:id</code>
        </li>
        <li>
          <code>POST /api/documents/bulk</code> · <code>POST /api/crawl</code> ·{' '}
          <code>GET /api/stats</code>
        </li>
        <li>
          <code>GET /api/plate/:reg</code> · <code>POST /api/plate/check</code>
        </li>
        <li>
          <code>GET /api/answer?q=…</code>
        </li>
        <li>
          <code>GET /api/settings</code> · <code>PATCH /api/settings</code> ·{' '}
          <code>POST /api/settings/reset</code>
        </li>
        <li>
          <code>GET /api/providers</code> · <code>POST /api/providers/:id/test</code>
        </li>
        <li>
          <code>GET /api/diagnostics</code>
        </li>
      </ul>
      <h3>Answers</h3>
      <p>
        For question-like queries (and for a bare email address or a quoted name) the{' '}
        <em>Search</em> tab also weaves a short written answer. It is built only from retrieved
        material — pages in the index plus, when a web-search provider is configured, live pages
        fetched at query time through the same robots / SSRF-guarded stack the crawler uses. Every
        sentence is tied to a numbered source; each source carries a trust tier (official /
        established / unverified reliability) and a fetch or index timestamp. Anything the sources
        do not support is labelled <em>unverified</em>, and a confidence banner summarises how
        well-grounded the answer is. With no LLM configured the answer is a deterministic weave of
        source extracts; with <code>ANTHROPIC_API_KEY</code> (or an OpenAI-compatible endpoint) it
        is written up in prose. All of it is optional.
      </p>
      <h3>Number plate checker</h3>
      <p>
        Typing <code>plate AB12CDE</code> into the universal box runs the same checks as the tool
        under Settings: format, age, and region, plus DVLA vehicle data and DVSA MOT history when
        those providers are configured. The card can set a reference date and save the check.
        Offline checks need no credentials.
      </p>
      <h3>CLI &amp; MCP</h3>
      <p>
        <code>beacon serve|add|import|crawl|search|stats</code>,{' '}
        <code>beacon plate &quot;AB12 CDE&quot;</code>. An MCP server (<code>beacon-mcp</code>)
        exposes the plate checker and the search index as tools for Claude and other MCP clients.
      </p>
    </section>
  );
}

const SECTIONS: Array<[SettingSection, string]> = [
  ['general', 'General'],
  ['search', 'Search'],
  ['sources', 'Sources'],
  ['ai', 'AI & Answers'],
  ['privacy', 'Privacy'],
  ['advanced', 'Advanced'],
];
const SECTION_LABEL: Record<SettingSection, string> = Object.fromEntries(SECTIONS) as Record<
  SettingSection,
  string
>;

/** A client (localStorage) or server (/api/settings) setting, rendered from its registry metadata. */
function SettingField({
  def,
  value,
  onChange,
  error,
  pending,
}: {
  def: SettingDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
  pending?: boolean;
}): JSX.Element {
  const id = `setting-${def.id}`;
  return (
    <div className={pending ? 'setting setting--pending' : 'setting'}>
      <div className="setting__row">
        <div className="setting__text">
          <label htmlFor={id} className="setting__label">
            {def.label}
          </label>
          {def.requiresRestart && <span className="setting__badge">restart required</span>}
          {def.description && <p className="setting__desc">{def.description}</p>}
        </div>
        <div className="setting__control">
          {def.type === 'toggle' && (
            <input
              id={id}
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => onChange(e.target.checked)}
            />
          )}
          {def.type === 'select' && (
            <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
              {def.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {def.type === 'number' && (
            <input
              id={id}
              type="number"
              value={String(value ?? '')}
              min={def.min}
              max={def.max}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
          {def.type === 'text' && (
            <input
              id={id}
              type="text"
              value={String(value ?? '')}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
      </div>
      {error && <p className="setting__error">{error}</p>}
    </div>
  );
}

function coerceClientValue(def: SettingDefinition, raw: unknown): unknown {
  return def.type === 'select' && typeof def.defaultValue === 'number' ? Number(raw) : raw;
}

function serverDefsFor(
  section: SettingSection,
  serverSettings: SettingsEntry[],
  llmNames: readonly string[],
): SettingDefinition[] {
  return serverSettings
    .map((entry) => serverEntryToDefinition(entry, llmNames))
    .filter((def) => inSection(def, section));
}

function SettingsSection({
  title,
  section,
  clientSettings,
  serverSettings,
  llmNames,
  pendingServer,
  serverErrors,
  onServerChange,
  onReset,
}: {
  title: string;
  section: SettingSection;
  clientSettings: ClientSettingsApi;
  serverSettings: SettingsEntry[];
  llmNames: readonly string[];
  pendingServer: Record<string, boolean | number | string>;
  serverErrors: Record<string, string>;
  onServerChange: (def: SettingDefinition, value: unknown) => void;
  onReset: () => void;
}): JSX.Element {
  const defs = [
    ...clientSettingsInSection(section),
    ...serverDefsFor(section, serverSettings, llmNames),
  ];
  return (
    <section className="settings__section">
      <div className="settings__section-head">
        <h2>{title}</h2>
        <button type="button" className="settings__restore" onClick={onReset}>
          Restore defaults
        </button>
      </div>
      <div className="settings__fields">
        {defs.map((def) => {
          if (def.scope === 'client') {
            return (
              <SettingField
                key={def.id}
                def={def}
                value={clientSettings.values[def.id]}
                onChange={(v) => clientSettings.setValue(def.id, coerceClientValue(def, v))}
              />
            );
          }
          const entry = serverSettings.find((e) => e.id === def.id);
          if (!entry) return null;
          const pendingVal = pendingServer[def.id];
          const value = pendingVal !== undefined ? pendingVal : entry.value;
          return (
            <SettingField
              key={def.id}
              def={def}
              value={value}
              error={serverErrors[def.id]}
              pending={pendingVal !== undefined}
              onChange={(v) => onServerChange(def, v)}
            />
          );
        })}
      </div>
    </section>
  );
}

const PROVIDER_STATUS_LABEL: Record<ProviderStatus['status'], string> = {
  connected: 'Connected',
  available: 'Available',
  disabled: 'Disabled',
  not_configured: 'Not configured',
  error: 'Error',
};
const PROVIDER_DOT_CLASS: Record<ProviderStatus['status'], string> = {
  connected: 'dot--ok',
  available: 'dot--ok',
  disabled: 'dot--off',
  not_configured: 'dot--warn',
  error: 'dot--fail',
};
const PROVIDER_GROUP_LABEL: Record<ProviderStatus['group'], string> = {
  web: 'Web',
  network: 'Network',
  vehicle: 'Vehicle data',
  ai: 'Answers',
};
const PROVIDER_GROUPS: Array<ProviderStatus['group']> = ['web', 'network', 'vehicle', 'ai'];

function SourcesSection({
  providers,
  onTested,
  region,
  serverSettings,
  llmNames,
  pendingServer,
  serverErrors,
  onServerChange,
}: {
  providers: ProviderStatus[] | null;
  onTested: () => void;
  region: unknown;
  serverSettings: SettingsEntry[];
  llmNames: readonly string[];
  pendingServer: Record<string, boolean | number | string>;
  serverErrors: Record<string, string>;
  onServerChange: (def: SettingDefinition, value: unknown) => void;
}): JSX.Element {
  const [testing, setTesting] = useState<string | null>(null);

  const runTest = (id: string) => {
    setTesting(id);
    api
      .testProvider(id)
      .catch(() => {
        /* the row's own status will show "error"; nothing more to surface here */
      })
      .finally(() => {
        setTesting(null);
        onTested();
      });
  };

  return (
    <section className="settings__section">
      <h2>Sources</h2>
      <p className="notice">
        Every source Beacon can actually use right now, derived live from its configuration —
        nothing here is hard-coded.
      </p>
      <div className="settings__fields">
        {serverDefsFor('sources', serverSettings, llmNames).map((def) => {
          const entry = serverSettings.find((e) => e.id === def.id);
          if (!entry) return null;
          const pendingVal = pendingServer[def.id];
          return (
            <SettingField
              key={def.id}
              def={def}
              value={pendingVal !== undefined ? pendingVal : entry.value}
              error={serverErrors[def.id]}
              pending={pendingVal !== undefined}
              onChange={(v) => onServerChange(def, v)}
            />
          );
        })}
      </div>
      {!providers && <p className="notice">Loading…</p>}
      {providers &&
        PROVIDER_GROUPS.map((group) => {
          const items = providers.filter((p) => p.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="provider-group">
              <h3>{PROVIDER_GROUP_LABEL[group]}</h3>
              <ul className="provider-list">
                {items.map((p) => (
                  <li key={p.id} className="provider-row">
                    <span className={`dot ${PROVIDER_DOT_CLASS[p.status]}`} aria-hidden />
                    <div className="provider-row__text">
                      <strong>{p.label}</strong>
                      <span className="provider-row__detail">{p.detail}</span>
                    </div>
                    <span className="provider-row__status">{PROVIDER_STATUS_LABEL[p.status]}</span>
                    {typeof p.latencyMs === 'number' && (
                      <span className="provider-row__latency">{p.latencyMs} ms</span>
                    )}
                    {p.lastCheckedAt && (
                      <span className="provider-row__checked">
                        {relativeTime(p.lastCheckedAt, region)}
                      </span>
                    )}
                    {p.testable && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => runTest(p.id)}
                        disabled={testing === p.id}
                      >
                        {testing === p.id ? 'Testing…' : 'Test connection'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
    </section>
  );
}

function PrivacySection({
  clientSettings,
  serverSettings,
  llmNames,
  serverErrors,
  onServerChange,
  onReset,
  historyCount,
  onClearHistory,
}: {
  clientSettings: ClientSettingsApi;
  serverSettings: SettingsEntry[];
  llmNames: readonly string[];
  serverErrors: Record<string, string>;
  onServerChange: (def: SettingDefinition, value: unknown) => void;
  onReset: () => void;
  historyCount: number;
  onClearHistory: () => void;
}): JSX.Element {
  const defs = [
    ...clientSettingsInSection('privacy'),
    ...serverDefsFor('privacy', serverSettings, llmNames),
  ];
  return (
    <section className="settings__section">
      <div className="settings__section-head">
        <h2>Privacy</h2>
        <button type="button" className="settings__restore" onClick={onReset}>
          Restore defaults
        </button>
      </div>
      <div className="settings__fields">
        {defs.map((def) => {
          if (def.scope === 'client') {
            return (
              <SettingField
                key={def.id}
                def={def}
                value={clientSettings.values[def.id]}
                onChange={(v) => clientSettings.setValue(def.id, coerceClientValue(def, v))}
              />
            );
          }
          const entry = serverSettings.find((e) => e.id === def.id);
          if (!entry) return null;
          return (
            <SettingField
              key={def.id}
              def={def}
              value={entry.value}
              error={serverErrors[def.id]}
              onChange={(v) => onServerChange(def, v)}
            />
          );
        })}
      </div>

      <div className="settings__history-action">
        <span>
          {historyCount} saved quer{historyCount === 1 ? 'y' : 'ies'} in this browser
        </span>
        <button
          type="button"
          className="btn btn--danger"
          onClick={onClearHistory}
          disabled={historyCount === 0}
        >
          Clear history
        </button>
      </div>

      <div className="prose prose--compact">
        <h3>What leaves this server</h3>
        <ul>
          <li>
            A domain/IP typed into the search box goes to public DNS resolvers and RDAP registries —
            no account, no key.
          </li>
          <li>
            A question-like query, when answer generation is on and a web search provider is
            configured, is sent to that provider, and the pages it returns are fetched directly.
          </li>
          <li>
            A configured LLM (Anthropic, or an OpenAI-compatible endpoint) receives the retrieved
            source extracts, not your raw query, to write the final answer.
          </li>
          <li>A plate check sends the registration to the DVLA/DVSA APIs, if configured.</li>
          <li>Nothing else leaves this server. There is no analytics or telemetry in Beacon.</li>
        </ul>
      </div>
    </section>
  );
}

const RANKING_IDS = ['answerTrustedDomains', 'answerStripTrackingParams'];
const NETWORK_IDS = ['lookupsTimeoutMs'];
const CRAWL_IDS = [
  'crawlMaxPages',
  'crawlConcurrency',
  'crawlTimeoutMs',
  'crawlDelayMs',
  'crawlAllowPrivateHosts',
];
const LOCAL_INDEX_IDS = ['persistDebounceMs'];
const TIMEOUT_IDS = [
  'plateTimeoutMs',
  'answerFetchTimeoutMs',
  'answerLlmTimeoutMs',
  'rateLimitMax',
  'rateLimitWindowMs',
];
const MASTER_IDS = ['answerEnabled'];

function AdvancedSection({
  serverSettings,
  llmNames,
  pendingServer,
  serverErrors,
  onServerChange,
  onReset,
  diagnostics,
  onDocumentsChanged,
  pageSize,
  region,
}: {
  serverSettings: SettingsEntry[];
  llmNames: readonly string[];
  pendingServer: Record<string, boolean | number | string>;
  serverErrors: Record<string, string>;
  onServerChange: (def: SettingDefinition, value: unknown) => void;
  onReset: () => void;
  diagnostics: DiagnosticsResponse | null;
  onDocumentsChanged: () => void;
  pageSize: number;
  region: unknown;
}): JSX.Element {
  const defs = serverSettings.map((entry) => serverEntryToDefinition(entry, llmNames));
  const byIds = (ids: string[]) =>
    ids
      .map((id) => defs.find((d) => d.id === id))
      .filter((d): d is SettingDefinition => Boolean(d));
  const grouped = new Set<string>([
    ...RANKING_IDS,
    ...NETWORK_IDS,
    ...CRAWL_IDS,
    ...LOCAL_INDEX_IDS,
    ...TIMEOUT_IDS,
    ...MASTER_IDS,
  ]);
  const other = defs.filter((def) => def.section === 'advanced' && !grouped.has(def.id));

  const field = (def: SettingDefinition) => {
    const entry = serverSettings.find((e) => e.id === def.id);
    if (!entry) return null;
    const pendingVal = pendingServer[def.id];
    const value = pendingVal !== undefined ? pendingVal : entry.value;
    return (
      <SettingField
        key={def.id}
        def={def}
        value={value}
        error={serverErrors[def.id]}
        pending={pendingVal !== undefined}
        onChange={(v) => onServerChange(def, v)}
      />
    );
  };

  return (
    <section className="settings__section">
      <div className="settings__section-head">
        <h2>Advanced</h2>
        <button type="button" className="settings__restore" onClick={onReset}>
          Restore defaults
        </button>
      </div>
      <p className="notice">
        Developer-level configuration. Defaults are sensible — change these only if you know why.
      </p>

      <details className="settings__group">
        <summary>Ranking</summary>
        <div className="settings__fields">{byIds(RANKING_IDS).map(field)}</div>
      </details>

      <details className="settings__group">
        <summary>Query classification</summary>
        <p className="notice">
          The universal box's classifier (domain / IP / calculation / plate / plain search) runs on
          fixed rules — there is nothing to configure here yet.
        </p>
      </details>

      <details className="settings__group">
        <summary>Network lookups</summary>
        <div className="settings__fields">{byIds(NETWORK_IDS).map(field)}</div>
      </details>

      <details className="settings__group">
        <summary>Crawling</summary>
        <div className="settings__fields">{byIds(CRAWL_IDS).map(field)}</div>
      </details>

      <details className="settings__group">
        <summary>Local index</summary>
        <div className="settings__fields">{byIds(LOCAL_INDEX_IDS).map(field)}</div>
        <LibraryView onDone={onDocumentsChanged} pageSize={pageSize} region={region} />
        <h3 className="settings__subhead">Number plate checker (advanced)</h3>
        <PlateView onDone={onDocumentsChanged} />
      </details>

      <details className="settings__group">
        <summary>Timeouts / retries</summary>
        <div className="settings__fields">{byIds(TIMEOUT_IDS).map(field)}</div>
      </details>

      <details className="settings__group">
        <summary>Answer engine (master switch)</summary>
        <div className="settings__fields">{byIds(MASTER_IDS).map(field)}</div>
      </details>

      {other.length > 0 && (
        <details className="settings__group">
          <summary>Other</summary>
          <div className="settings__fields">{other.map(field)}</div>
        </details>
      )}

      <details className="settings__group">
        <summary>API</summary>
        <ul className="settings__api-list">
          <li>
            <code>GET /api/search</code> · <code>GET /api/query</code> ·{' '}
            <code>GET /api/suggest</code>
          </li>
          <li>
            <code>GET/POST/PUT/DELETE /api/documents</code> · <code>POST /api/documents/bulk</code>
          </li>
          <li>
            <code>POST /api/crawl</code> · <code>POST /api/index/clear</code>
          </li>
          <li>
            <code>GET /api/plate/:reg</code> · <code>POST /api/plate/check</code>
          </li>
          <li>
            <code>GET /api/answer</code>
          </li>
          <li>
            <code>GET/PATCH /api/settings</code> · <code>POST /api/settings/reset</code>
          </li>
          <li>
            <code>GET /api/providers</code> · <code>POST /api/providers/:id/test</code>
          </li>
          <li>
            <code>GET /api/health</code> · <code>GET /api/diagnostics</code> ·{' '}
            <code>GET /api/stats</code>
          </li>
        </ul>
      </details>

      <details className="settings__group">
        <summary>MCP</summary>
        <p className="notice">
          <code>beacon-mcp</code> exposes the plate checker and the search index as tools for Claude
          and other MCP clients. See the Docs tab for the CLI commands.
        </p>
      </details>

      <details className="settings__group" open>
        <summary>Diagnostics</summary>
        {diagnostics ? (
          <dl className="diagnostics">
            <div>
              <dt>Status</dt>
              <dd>{diagnostics.status}</dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{Math.round(diagnostics.uptimeSeconds / 60)}m</dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>{relativeTime(diagnostics.checkedAt, region)}</dd>
            </div>
            <div>
              <dt>Documents</dt>
              <dd>{diagnostics.documents.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Tags</dt>
              <dd>{diagnostics.tags}</dd>
            </div>
            <div>
              <dt>Sources (tag)</dt>
              <dd>{diagnostics.sources}</dd>
            </div>
            <div>
              <dt>Last persisted</dt>
              <dd>
                {diagnostics.lastPersistedAt
                  ? relativeTime(diagnostics.lastPersistedAt, region)
                  : 'never'}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="notice">Diagnostics unavailable.</p>
        )}
      </details>
    </section>
  );
}

const HEALTH_ROW_LABEL: Partial<Record<string, string>> = {
  domain_lookups: 'DNS / RDAP',
  dvla_vehicle: 'Vehicle data',
};

function HealthPanel({
  diagnostics,
  health,
  region,
  onRefresh,
  onSeeDetails,
}: {
  diagnostics: DiagnosticsResponse | null;
  health: HealthResponse | null;
  region: unknown;
  onRefresh: () => void;
  onSeeDetails: () => void;
}): JSX.Element {
  const rows: Array<{ label: string; status: ProviderStatus['status']; detail: string }> = [
    {
      label: 'Search API',
      status: diagnostics ? 'connected' : 'error',
      detail: diagnostics ? 'Healthy' : 'Unreachable',
    },
    { label: 'Local index', status: 'connected', detail: 'Ready' },
  ];

  if (diagnostics) {
    for (const p of diagnostics.providers) {
      if (p.id === 'local_index' || p.id === 'crawler') continue;
      if (p.id === 'answer_llm') {
        const llmOn = Boolean(health && health.answer.llm.length > 0);
        rows.push({
          label: 'Answer engine',
          status: llmOn ? 'connected' : health?.answer.enabled ? 'available' : 'disabled',
          detail: llmOn
            ? health!.answer.llm.join(', ')
            : health?.answer.enabled
              ? 'Extractive'
              : 'Disabled',
        });
        continue;
      }
      const connectedDetail =
        p.status === 'connected' && typeof p.latencyMs === 'number'
          ? `Connected · ${p.latencyMs} ms`
          : PROVIDER_STATUS_LABEL[p.status];
      const label =
        p.id === 'answer_web_search'
          ? (health?.answer.webSearch ?? p.label)
          : (HEALTH_ROW_LABEL[p.id] ?? p.label);
      rows.push({ label, status: p.status, detail: connectedDetail });
    }
  }

  return (
    <section className="health">
      <div className="health__head">
        <h2>System health</h2>
        <div className="health__actions">
          <button type="button" className="search__filters-toggle" onClick={onRefresh}>
            refresh
          </button>
          <button type="button" className="search__filters-toggle" onClick={onSeeDetails}>
            detailed diagnostics
          </button>
        </div>
      </div>
      <ul className="health__list">
        {rows.map((r) => (
          <li key={r.label}>
            <span className={`dot ${PROVIDER_DOT_CLASS[r.status]}`} aria-hidden />
            <span className="health__label">{r.label}</span>
            <span className="health__detail">{r.detail}</span>
          </li>
        ))}
      </ul>
      {diagnostics && (
        <p className="health__foot">
          Uptime {Math.round(diagnostics.uptimeSeconds / 60)}m · checked{' '}
          {relativeTime(diagnostics.checkedAt, region)}
          {health ? ` · ${health.documents.toLocaleString()} documents` : ''}
        </p>
      )}
    </section>
  );
}

function SettingsView({
  health,
  onSettingsChanged,
  clientSettings,
  historyCount,
  onClearHistory,
}: {
  health: HealthResponse | null;
  onSettingsChanged: () => void;
  clientSettings: ClientSettingsApi;
  historyCount: number;
  onClearHistory: () => void;
}): JSX.Element {
  const [section, setSection] = useState<SettingSection>('general');
  const [serverSettings, setServerSettings] = useState<SettingsEntry[]>([]);
  const [pendingServer, setPendingServer] = useState<Record<string, boolean | number | string>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [settingsQuery, setSettingsQuery] = useState('');

  const refreshSettings = useCallback(() => {
    api
      .settings()
      .then((res) => setServerSettings(res.settings))
      .catch(() => {
        /* leave the previous list in place — the fields just won't update */
      });
  }, []);
  useEffect(refreshSettings, [refreshSettings]);

  const refreshDiagnostics = useCallback(() => {
    api
      .diagnostics()
      .then(setDiagnostics)
      .catch(() => setDiagnostics(null));
  }, []);
  useEffect(refreshDiagnostics, [refreshDiagnostics]);

  const refreshProviders = useCallback(() => {
    api
      .providers()
      .then((res) => setProviders(res.providers))
      .catch(() => setProviders(null));
  }, []);
  useEffect(refreshProviders, [refreshProviders]);

  const refreshAll = () => {
    refreshDiagnostics();
    refreshProviders();
  };

  const handleServerChange = (def: SettingDefinition, raw: unknown) => {
    setServerErrors((prev) => {
      if (!(def.id in prev)) return prev;
      const next = { ...prev };
      delete next[def.id];
      return next;
    });
    if (def.type === 'toggle' || def.type === 'select') {
      const value = def.type === 'toggle' ? Boolean(raw) : String(raw);
      api
        .patchSettings({ [def.id]: value })
        .then((res) => {
          setServerSettings(res.settings);
          const fieldError = res.errors[def.id];
          if (fieldError) setServerErrors((prev) => ({ ...prev, [def.id]: fieldError }));
          onSettingsChanged();
        })
        .catch((err: unknown) =>
          setServerErrors((prev) => ({
            ...prev,
            [def.id]: err instanceof Error ? err.message : 'Failed to save',
          })),
        );
    } else {
      setPendingServer((prev) => ({ ...prev, [def.id]: raw as string }));
    }
  };

  const saveChanges = () => {
    setSaving(true);
    const patch: Record<string, boolean | number | string> = {};
    for (const [id, raw] of Object.entries(pendingServer)) {
      const entry = serverSettings.find((item) => item.id === id);
      patch[id] = entry?.type === 'number' ? Number(raw) : raw;
    }
    api
      .patchSettings(patch)
      .then((res) => {
        setServerSettings(res.settings);
        setServerErrors(res.errors);
        setPendingServer((prev) => {
          const next = { ...prev };
          for (const id of res.applied) delete next[id];
          return next;
        });
        onSettingsChanged();
      })
      .catch(() => {
        /* network-level failure — the pending edits stay so the user can retry */
      })
      .finally(() => setSaving(false));
  };

  const discardChanges = () => {
    setPendingServer({});
    setServerErrors({});
  };

  const llmNames = health?.answer.llm ?? [];
  const pageSize = Number(clientSettings.values.resultsPerPage) || DEFAULT_PAGE_SIZE;
  const region = clientSettings.values.region;
  const liveServerDefs = serverSettings.map((entry) => serverEntryToDefinition(entry, llmNames));

  const resetSection = (target: SettingSection) => {
    const defs = [
      ...clientSettingsInSection(target),
      ...liveServerDefs.filter((def) => inSection(def, target)),
    ];
    const clientIds = defs.filter((d) => d.scope === 'client').map((d) => d.id);
    const serverIds = defs.filter((d) => d.scope === 'server').map((d) => d.id);
    if (clientIds.length > 0) clientSettings.resetIds(clientIds);
    if (serverIds.length > 0) {
      api
        .resetSettings(serverIds)
        .then((res) => {
          setServerSettings(res.settings);
          setPendingServer((prev) => {
            const next = { ...prev };
            for (const id of serverIds) delete next[id];
            return next;
          });
          setServerErrors((prev) => {
            const next = { ...prev };
            for (const id of serverIds) delete next[id];
            return next;
          });
          onSettingsChanged();
        })
        .catch(() => {
          /* leave things as they were — nothing was reset */
        });
    }
  };

  const pendingCount = Object.keys(pendingServer).length;
  const foundSettings = settingsQuery.trim() ? searchSettings(settingsQuery, liveServerDefs) : [];

  return (
    <section className="settings">
      <HealthPanel
        diagnostics={diagnostics}
        health={health}
        region={region}
        onRefresh={refreshAll}
        onSeeDetails={() => setSection('advanced')}
      />

      <div className="settings__search">
        <input
          type="search"
          placeholder="Search settings…"
          value={settingsQuery}
          onChange={(e) => setSettingsQuery(e.target.value)}
        />
        {settingsQuery.trim() && (
          <ul className="settings__search-results">
            {foundSettings.length === 0 && (
              <li className="settings__search-empty">No matching settings.</li>
            )}
            {foundSettings.map((def) => (
              <li key={def.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSection(def.section);
                    setSettingsQuery('');
                  }}
                >
                  {def.label}{' '}
                  <span className="settings__search-section">{SECTION_LABEL[def.section]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="settings__layout">
        <nav className="settings__nav" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={
                section === id ? 'settings__nav-btn settings__nav-btn--active' : 'settings__nav-btn'
              }
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="settings__panel">
          {section === 'general' && (
            <SettingsSection
              title="General"
              section="general"
              clientSettings={clientSettings}
              serverSettings={serverSettings}
              llmNames={llmNames}
              pendingServer={pendingServer}
              serverErrors={serverErrors}
              onServerChange={handleServerChange}
              onReset={() => resetSection('general')}
            />
          )}
          {section === 'search' && (
            <SettingsSection
              title="Search"
              section="search"
              clientSettings={clientSettings}
              serverSettings={serverSettings}
              llmNames={llmNames}
              pendingServer={pendingServer}
              serverErrors={serverErrors}
              onServerChange={handleServerChange}
              onReset={() => resetSection('search')}
            />
          )}
          {section === 'sources' && (
            <SourcesSection
              providers={providers}
              onTested={refreshProviders}
              region={region}
              serverSettings={serverSettings}
              llmNames={llmNames}
              pendingServer={pendingServer}
              serverErrors={serverErrors}
              onServerChange={handleServerChange}
            />
          )}
          {section === 'ai' && (
            <SettingsSection
              title="AI & Answers"
              section="ai"
              clientSettings={clientSettings}
              serverSettings={serverSettings}
              llmNames={llmNames}
              pendingServer={pendingServer}
              serverErrors={serverErrors}
              onServerChange={handleServerChange}
              onReset={() => resetSection('ai')}
            />
          )}
          {section === 'privacy' && (
            <PrivacySection
              clientSettings={clientSettings}
              serverSettings={serverSettings}
              llmNames={llmNames}
              serverErrors={serverErrors}
              onServerChange={handleServerChange}
              onReset={() => resetSection('privacy')}
              historyCount={historyCount}
              onClearHistory={onClearHistory}
            />
          )}
          {section === 'advanced' && (
            <AdvancedSection
              serverSettings={serverSettings}
              llmNames={llmNames}
              pendingServer={pendingServer}
              serverErrors={serverErrors}
              onServerChange={handleServerChange}
              onReset={() => resetSection('advanced')}
              diagnostics={diagnostics}
              onDocumentsChanged={refreshAll}
              pageSize={pageSize}
              region={region}
            />
          )}
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="settings__unsaved" role="status">
          <span>
            {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'}
          </span>
          <button type="button" className="btn" onClick={discardChanges} disabled={saving}>
            Discard
          </button>
          <button type="button" className="btn btn--active" onClick={saveChanges} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </section>
  );
}
