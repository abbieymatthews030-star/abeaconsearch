import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type AnswerConfidence,
  type AnswerResponse,
  type BeaconDocument,
  type CalculationPrimary,
  type DomainPrimary,
  type HealthResponse,
  type IndexStats,
  type IpPrimary,
  type PlateCheck,
  type PrimaryResult,
  type QueryKind,
  type SearchSort,
  type TrustTier,
  type UniversalQueryResponse,
} from './api';

type Tab = 'search' | 'history' | 'sources' | 'settings';

const PAGE_SIZE = 10;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const QUESTION_STARTS =
  /^(who|what|whats|when|where|why|how|is|are|was|were|does|do|did|can|could|should|would|will|which|whom|whose|define|explain|tell)\b/i;

/** Heuristic: does this query read like a question worth auto-answering? */
function isQuestionLike(q: string): boolean {
  const t = q.trim();
  if (t.length < 8) return false;
  if (t.includes('?')) return true;
  if (QUESTION_STARTS.test(t)) return true;
  return t.split(/\s+/).length >= 4;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A bare email or a quoted name reads as "research this", not "search for this text". */
function looksLikeResearchTarget(q: string): boolean {
  const t = q.trim();
  if (EMAIL_RE.test(t)) return true;
  const quoted = /^["“](.+)["”]$/.exec(t);
  return Boolean(quoted?.[1]?.trim());
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const secs = Math.max(1, Math.round((Date.now() - then) / 1000));
  for (const [size, label] of [
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ] as Array<[number, string]>) {
    if (secs >= size) return `${Math.floor(secs / size)}${label} ago`;
  }
  return `${secs}s ago`;
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
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());

  const refreshStats = useCallback(() => {
    api
      .stats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);
  useEffect(refreshStats, [refreshStats]);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const recordHistory = useCallback((query: string, kind: QueryKind) => {
    const q = query.trim();
    if (!q) return;
    setHistory((prev) => {
      if (prev[0]?.query === q) return prev;
      const next = [{ query: q, kind, at: new Date().toISOString() }, ...prev.filter((e) => e.query !== q)].slice(
        0,
        HISTORY_LIMIT,
      );
      saveHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
  }, []);

  const runFromHistory = (query: string) => {
    setInput(query);
    setTab('search');
  };

  const connectedSources = countConnectedSources(health);

  return (
    <div className="app">
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
              ['sources', 'Sources'],
              ['settings', 'Settings'],
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
        {tab === 'search' && <SearchView input={input} onInputChange={setInput} onCommit={recordHistory} health={health} />}
        {tab === 'history' && <HistoryView entries={history} onPick={runFromHistory} onClear={clearHistory} />}
        {tab === 'sources' && <SourcesView stats={stats} health={health} onDone={refreshStats} />}
        {tab === 'settings' && <SettingsView stats={stats} health={health} />}
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
}: {
  input: string;
  onInputChange: (value: string) => void;
  onCommit: (query: string, kind: QueryKind) => void;
  health: HealthResponse | null;
}): JSX.Element {
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sort, setSort] = useState<SearchSort>('relevance');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<UniversalQueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const query = useDebounced(input, 200);
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
  const answerAbort = useRef<AbortController | null>(null);

  const runAnswer = useCallback((q: string, fresh: boolean) => {
    answerAbort.current?.abort();
    const controller = new AbortController();
    answerAbort.current = controller;
    setAnswerRequested(true);
    setAnswerLoading(true);
    setAnswerError(null);
    api
      .answer(q, fresh, controller.signal)
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

  useEffect(() => {
    answerAbort.current?.abort();
    setAnswer(null);
    setAnswerError(null);
    setAnswerRequested(false);
    setAnswerLoading(false);
    if (!answersEnabled || !answerQuery) return;
    if (isQuestionLike(answerQuery) || looksLikeResearchTarget(answerQuery)) runAnswer(answerQuery, false);
  }, [answerQuery, answersEnabled, runAnswer]);

  useEffect(() => {
    setPage(0);
  }, [query, activeTags, sort]);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    api
      .query(
        { q: query, limit: PAGE_SIZE, offset: page * PAGE_SIZE, tags: activeTags, sort },
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
  }, [query, page, activeTags, sort]);

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
  const totalPages = local ? Math.max(1, Math.ceil(local.total / PAGE_SIZE)) : 1;
  const facetTags = useMemo(
    () =>
      local
        ? Object.entries(local.facets.tags)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
        : [],
    [local],
  );

  const toggleTag = (tag: string) =>
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const hasFilters = (local?.total ?? 0) > 1 || activeTags.length > 0 || facetTags.length > 0;

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

      {answersEnabled && answerQuery && !answerRequested && (
        <button type="button" className="answer__cta" onClick={() => runAnswer(answerQuery, false)}>
          ↳ weave an answer for “{answerQuery}”
        </button>
      )}

      {answerError && answerRequested && (
        <p className="notice notice--error">answer: {answerError}</p>
      )}

      {answerRequested && (answer || answerLoading) && (
        <AnswerCard
          data={answer}
          loading={answerLoading}
          onRefresh={() => runAnswer(answerQuery || query, true)}
        />
      )}

      {local && (
        <p className="search__meta">
          <strong>{local.total.toLocaleString()}</strong> result{local.total === 1 ? '' : 's'}
          {local.query ? ` for “${local.query}”` : ''} · {local.tookMs} ms
          {loading && (
            <>
              {' · '}
              <span className="search__updating" aria-hidden /> updating
            </>
          )}
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
          {local && local.total > 1 && (
            <label className="search__sort">
              sort
              <select value={sort} onChange={(event) => setSort(event.target.value as SearchSort)}>
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
        </div>
      )}

      <ol className="results">
        {local?.hits.map((hit) => (
          <li key={hit.id} className="result">
            <h3 className="result__title">
              {hit.url ? (
                <a href={hit.url} target="_blank" rel="noreferrer">
                  <span dangerouslySetInnerHTML={{ __html: hit.title }} />
                </a>
              ) : (
                <span dangerouslySetInnerHTML={{ __html: hit.title }} />
              )}
            </h3>
            {hit.url && <div className="result__url">{hit.url}</div>}
            <p className="result__snippet" dangerouslySetInnerHTML={{ __html: hit.snippet }} />
            <div className="result__foot">
              {hit.source && <span className="result__source">{hit.source}</span>}
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
              {hit.score > 0 && <span className="result__score">score {hit.score}</span>}
            </div>
          </li>
        ))}
      </ol>

      {local && local.total === 0 && !loading && !result?.primary && (
        <div className="empty">
          <Beacon size={150} />
          <strong>{query ? 'nothing matched' : 'ready'}</strong>
          <span>
            {query
              ? 'Nothing in the index matched. Try a different query, or clear the active filters.'
              : 'Type to search — a domain, an IP, a calculation, a plate, or plain text.'}
          </span>
          {local.suggestion && (
            <button
              type="button"
              className="answer__cta"
              onClick={() => onInputChange(local.suggestion!)}
            >
              ↳ did you mean “{local.suggestion}”?
            </button>
          )}
          {query && answersEnabled && !answerRequested && (
            <button type="button" className="answer__cta" onClick={() => runAnswer(query, false)}>
              ↳ weave an answer from live sources instead
            </button>
          )}
          <span className="empty__dots" aria-hidden>
            . . . . . . .
          </span>
        </div>
      )}

      {local && local.total > PAGE_SIZE && (
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
      return (
        <section className="primary-card primary-card--plate">
          <PlateReport report={primary.data} />
        </section>
      );
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
  onPick,
  onClear,
}: {
  entries: HistoryEntry[];
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
              <span className="history__time">{relativeTime(entry.at)}</span>
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

// --- Sources (connected capabilities + document management) -----------------

function SourcesView({
  stats,
  health,
  onDone,
}: {
  stats: IndexStats | null;
  health: HealthResponse | null;
  onDone: () => void;
}): JSX.Element {
  const dot = (on: boolean) => (on ? 'sources__dot sources__dot--on' : 'sources__dot');

  return (
    <section className="sources">
      <section className="sources__overview">
        <h2>Connected sources</h2>
        <ul className="sources__list">
          <li>
            <span className={dot(true)} aria-hidden />
            Local full-text index
            <span className="sources__detail">
              {stats ? `${stats.documents.toLocaleString()} documents` : '—'}
            </span>
          </li>
          <li>
            <span className={dot(true)} aria-hidden />
            Web crawler
            <span className="sources__detail">fetch &amp; index pages on demand</span>
          </li>
          <li>
            <span className={dot(Boolean(health?.lookups.enabled))} aria-hidden />
            Domain / IP lookups (DNS + RDAP)
            <span className="sources__detail">
              {health ? (health.lookups.enabled ? 'enabled' : 'disabled') : '—'}
            </span>
          </li>
          <li>
            <span className={dot(Boolean(health?.plateChecks.vehicleData))} aria-hidden />
            DVLA vehicle data
            <span className="sources__detail">
              {health ? (health.plateChecks.vehicleData ? 'configured' : 'not configured') : '—'}
            </span>
          </li>
          <li>
            <span className={dot(Boolean(health?.plateChecks.motHistory))} aria-hidden />
            DVSA MOT history
            <span className="sources__detail">
              {health ? (health.plateChecks.motHistory ? 'configured' : 'not configured') : '—'}
            </span>
          </li>
          <li>
            <span className={dot(Boolean(health?.answer.webSearch))} aria-hidden />
            Answer web search
            <span className="sources__detail">{health?.answer.webSearch ?? 'not configured'}</span>
          </li>
          <li>
            <span className={dot(Boolean(health && health.answer.llm.length > 0))} aria-hidden />
            Answer writer (LLM)
            <span className="sources__detail">
              {health && health.answer.llm.length > 0 ? health.answer.llm.join(', ') : 'extractive only'}
            </span>
          </li>
        </ul>
      </section>

      <LibraryView onDone={onDone} />
    </section>
  );
}

function LibraryView({ onDone }: { onDone: () => void }): JSX.Element {
  const [docs, setDocs] = useState<BeaconDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'add' | 'crawl' | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .documents({ limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((res) => {
        setDocs(res.documents);
        setTotal(res.total);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Failed to load documents'),
      )
      .finally(() => setLoading(false));
  }, [page]);

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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
      {panel === 'crawl' && <CrawlView onDone={handleAdded} />}

      {error && <p className="notice notice--error">{error}</p>}

      <p className="search__meta">
        <strong>{total.toLocaleString()}</strong> document{total === 1 ? '' : 's'} indexed
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
                  {doc.source && <span>{doc.source}</span>}
                  {doc.tags.length > 0 && <span>{doc.tags.join(', ')}</span>}
                  <span>{relativeTime(doc.updatedAt)}</span>
                </div>
              </div>
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

      {total > PAGE_SIZE && (
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

function ConfidenceBadge({ confidence }: { confidence: AnswerConfidence }): JSX.Element {
  const cls =
    confidence === 'high' || confidence === 'medium'
      ? 'badge badge--ok'
      : confidence === 'low'
        ? 'badge badge--warn'
        : 'badge badge--fail';
  return <span className={cls}>{confidence} confidence</span>;
}

function AnswerCard({
  data,
  loading,
  onRefresh,
}: {
  data: AnswerResponse | null;
  loading: boolean;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <section className="answer" aria-busy={loading}>
      <div className="answer__head">
        <span className="answer__tag">ANSWER</span>
        {data && <ConfidenceBadge confidence={data.confidence} />}
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

          {data.claims.length > 0 ? (
            <p className="answer__body">
              {data.claims.map((claim, i) => (
                <span key={i} className={claim.supported ? 'claim' : 'claim claim--unverified'}>
                  {stripCitations(claim.text)}{' '}
                  {claim.sourceIds.map((id) => (
                    <a key={id} href={`#answer-src-${id}`} className="cite">
                      [{id}]
                    </a>
                  ))}
                  {!claim.supported && <span className="claim__flag">unverified</span>}{' '}
                </span>
              ))}
            </p>
          ) : (
            <p className="answer__body">{data.answer}</p>
          )}

          {data.disclaimer && <p className="answer__disclaimer">⚠ {data.disclaimer}</p>}

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
                    <span className={`trust trust--${source.trust}`}>
                      {TRUST_LABEL[source.trust]}
                    </span>
                    {source.domain && <span>{source.domain}</span>}
                    <span>
                      {source.live ? 'fetched ' : 'indexed '}
                      {relativeTime(source.retrievedAt)}
                    </span>
                  </div>
                  <div className="answer__source-why">{source.trustReason}</div>
                  <p className="answer__quote">“{source.quote}”</p>
                </li>
              ))}
            </ol>
          )}

          {data.warnings.length > 0 && (
            <ul className="answer__warnings">
              {data.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}

          <p className="answer__foot">
            {data.synthesizer === 'extractive'
              ? 'assembled from source extracts (no LLM configured)'
              : `woven by ${data.synthesizer.replace('llm-', '')}`}
            {' · '}
            {data.sources.length} source{data.sources.length === 1 ? '' : 's'}
            {' · '}
            {Math.round(data.tookMs)} ms{data.cached ? ' · cached' : ''}
          </p>
        </>
      )}
    </section>
  );
}

function AddView({ onDone }: { onDone: () => void }): JSX.Element {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    api
      .addDocument({
        title: title.trim(),
        body,
        url: url.trim() || undefined,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      })
      .then((doc) => {
        setStatus({ kind: 'ok', text: `Indexed "${doc.title}" (id: ${doc.id})` });
        setTitle('');
        setBody('');
        setUrl('');
        setTags('');
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
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={1024} />
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
        {busy ? 'Indexing…' : 'Add to index'}
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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    api
      .crawl({
        url: url.trim(),
        maxPages: Number(maxPages) || undefined,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      })
      .then((res) => {
        setStatus({
          kind: 'ok',
          text: `Crawled ${res.pagesCrawled} pages, indexed ${res.documentsIndexed}, ${res.errors.length} errors.`,
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
        Fetches HTML pages starting from a URL, follows same-origin links and indexes the text.
        Respects <code>robots.txt</code>. Large crawls can take a while — the request completes when
        the crawl finishes.
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
      <button type="submit" className="btn" disabled={busy || url.trim() === ''}>
        {busy ? 'Crawling…' : 'Start crawl'}
      </button>
      {status && (
        <p className={status.kind === 'ok' ? 'notice notice--ok' : 'notice notice--error'}>
          {status.text}
        </p>
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

function PlateView({ onDone }: { onDone: () => void }): JSX.Element {
  const [input, setInput] = useState('');
  const [vehicle, setVehicle] = useState(true);
  const [mot, setMot] = useState(true);
  const [index, setIndex] = useState(false);
  const [report, setReport] = useState<PlateCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    api
      .checkPlate({ plate: input.trim(), vehicle, mot, index })
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
      <div className="plate__opts">
        <label>
          <input type="checkbox" checked={vehicle} onChange={(e) => setVehicle(e.target.checked)} />{' '}
          DVLA vehicle data
        </label>
        <label>
          <input type="checkbox" checked={mot} onChange={(e) => setMot(e.target.checked)} /> MOT
          history
        </label>
        <label>
          <input type="checkbox" checked={index} onChange={(e) => setIndex(e.target.checked)} />{' '}
          Save to index
        </label>
      </div>

      {error && <p className="notice notice--error">{error}</p>}

      {report && <PlateReport report={report} />}
    </section>
  );
}

function AboutView(): JSX.Element {
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
        classifies what you typed and — when it recognises the shape — attaches a structured
        result: a bare domain resolves DNS + RDAP registration data, an IP resolves reverse DNS +
        RDAP network data, an arithmetic expression is evaluated directly, and <code>plate &lt;reg&gt;</code>{' '}
        runs the number plate checker. Everything else is just a search. Domain/IP lookups need no
        API key (DNS and RDAP are open internet infrastructure) but can be turned off entirely with{' '}
        <code>BEACON_LOOKUPS_ENABLED=false</code> for a fully offline deployment.
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
      </ul>
      <h3>Answers</h3>
      <p>
        For question-like queries (and for a bare email address or a quoted name) the <em>Search</em>{' '}
        tab also weaves a short written answer. It is built only from retrieved material — pages in
        the index plus, when a web-search provider is configured, live pages fetched at query time
        through the same robots / SSRF-guarded stack the crawler uses. Every sentence is tied to a
        numbered source; each source carries a trust tier (official / established / unverified
        reliability) and a fetch or index timestamp. Anything the sources do not support is labelled{' '}
        <em>unverified</em>, and a confidence banner summarises how well-grounded the answer is. With
        no LLM configured the answer is a deterministic weave of source extracts; with{' '}
        <code>ANTHROPIC_API_KEY</code> (or an OpenAI-compatible endpoint) it is written up in prose.
        All of it is optional.
      </p>
      <h3>Number plate checker</h3>
      <p>
        Typing <code>plate AB12CDE</code> into the universal box runs the offline checks (format,
        age identifier, DVLA region) inline. The advanced tool in Settings adds DVLA tax/MOT status
        and DVSA MOT history lookups when API keys are configured. Offline checks need no
        credentials.
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

function SettingsView({
  stats,
  health,
}: {
  stats: IndexStats | null;
  health: HealthResponse | null;
}): JSX.Element {
  const answerStatus = health
    ? health.answer.enabled
      ? health.answer.llm.length > 0
        ? `on · ${health.answer.llm.join(', ')}`
        : 'on · extractive (no LLM key)'
      : 'off'
    : '—';

  return (
    <section className="settings">
      <section className="settings__section">
        <h2>Diagnostics</h2>
        <dl className="diagnostics">
          <div>
            <dt>Documents</dt>
            <dd>{stats ? stats.documents.toLocaleString() : '—'}</dd>
          </div>
          <div>
            <dt>Tags / sources</dt>
            <dd>{stats ? `${stats.tags} / ${stats.sources}` : '—'}</dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>{health ? `${Math.round(health.uptimeSeconds / 60)}m` : '—'}</dd>
          </div>
          <div>
            <dt>Answer weave</dt>
            <dd>{answerStatus}</dd>
          </div>
          <div>
            <dt>Web search provider</dt>
            <dd>{health?.answer.webSearch ?? 'none configured'}</dd>
          </div>
          <div>
            <dt>Domain / IP lookups</dt>
            <dd>{health ? (health.lookups.enabled ? 'enabled' : 'disabled') : '—'}</dd>
          </div>
          <div>
            <dt>DVLA vehicle data</dt>
            <dd>{health ? (health.plateChecks.vehicleData ? 'configured' : 'not configured') : '—'}</dd>
          </div>
          <div>
            <dt>DVSA MOT history</dt>
            <dd>{health ? (health.plateChecks.motHistory ? 'configured' : 'not configured') : '—'}</dd>
          </div>
        </dl>
      </section>

      <details className="settings__tool">
        <summary>Number plate checker (advanced)</summary>
        <PlateView onDone={() => {}} />
      </details>

      <AboutView />
    </section>
  );
}
