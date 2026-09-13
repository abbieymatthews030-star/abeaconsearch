import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type AnswerConfidence,
  type AnswerResponse,
  type HealthResponse,
  type IndexStats,
  type PlateCheck,
  type SearchResponse,
  type TrustTier,
} from './api';

type Tab = 'search' | 'plate' | 'add' | 'crawl' | 'about';

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

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('search');
  const [stats, setStats] = useState<IndexStats | null>(null);

  const refreshStats = useCallback(() => {
    api
      .stats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  useEffect(refreshStats, [refreshStats]);

  return (
    <div className="app">
      <header className="app__header">
        <div className="brand">
          <Beacon size={40} />
          <h1>ABEACON</h1>
          <p>self-hostable full-text search</p>
        </div>
        <nav className="tabs" aria-label="Sections">
          {(
            [
              ['search', 'Search'],
              ['plate', 'Plate check'],
              ['add', 'Add document'],
              ['crawl', 'Crawl site'],
              ['about', 'About'],
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
        {tab === 'search' && <SearchView />}
        {tab === 'plate' && <PlateView onDone={refreshStats} />}
        {tab === 'add' && <AddView onDone={refreshStats} />}
        {tab === 'crawl' && <CrawlView onDone={refreshStats} />}
        {tab === 'about' && <AboutView />}
      </main>

      <footer className="app__footer">
        {stats ? (
          <span>
            {stats.documents.toLocaleString()} documents · {stats.tags} tags · {stats.sources}{' '}
            sources
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

function SearchView(): JSX.Element {
  const [input, setInput] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const query = useDebounced(input, 200);
  const answerQuery = useDebounced(input.trim(), 900);
  const abortRef = useRef<AbortController | null>(null);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const answersEnabled = health?.answer.enabled ?? false;
  const [answer, setAnswer] = useState<AnswerResponse | null>(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [answerRequested, setAnswerRequested] = useState(false);
  const answerAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

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
    if (isQuestionLike(answerQuery)) runAnswer(answerQuery, false);
  }, [answerQuery, answersEnabled, runAnswer]);

  useEffect(() => {
    setPage(0);
  }, [query, activeTags]);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    api
      .search(
        { q: query, limit: PAGE_SIZE, offset: page * PAGE_SIZE, tags: activeTags },
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
  }, [query, page, activeTags]);

  const totalPages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  const facetTags = useMemo(
    () =>
      result
        ? Object.entries(result.facets.tags)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
        : [],
    [result],
  );

  const toggleTag = (tag: string) =>
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  return (
    <section className="search">
      <div className="search__box">
        <input
          type="search"
          autoFocus
          placeholder="search the index"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          aria-label="Search query"
        />
        {input && (
          <button
            type="button"
            className="search__clear"
            onClick={() => setInput('')}
            aria-label="Clear search"
          >
            clear
          </button>
        )}
      </div>

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

      {error && <p className="notice notice--error">{error}</p>}

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

      {result && (
        <p className="search__meta">
          <strong>{result.total.toLocaleString()}</strong> result{result.total === 1 ? '' : 's'}
          {result.query ? ` for “${result.query}”` : ''} · {result.tookMs} ms
          {loading && (
            <>
              {' · '}
              <span className="search__updating" aria-hidden /> updating
            </>
          )}
        </p>
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

      <ol className="results">
        {result?.hits.map((hit) => (
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

      {result && result.total === 0 && !loading && (
        <div className="empty">
          <Beacon size={150} />
          <strong>{query ? 'no documents matched' : 'index ready'}</strong>
          <span>
            {query
              ? 'Nothing in the index matched. Try a different query, or clear the active tag filters.'
              : 'Type to search, or use Add / Crawl to fill the index.'}
          </span>
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

      {result && result.total > PAGE_SIZE && (
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

function PlateView({ onDone }: { onDone: () => void }): JSX.Element {
  const [input, setInput] = useState('');
  const [country, setCountry] = useState<'' | 'GB' | 'AU'>('');
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
      .checkPlate({
        plate: input.trim(),
        country: country || undefined,
        vehicle: country === 'AU' ? false : vehicle,
        mot: country === 'AU' ? false : mot,
        index,
      })
      .then((res) => {
        setReport(res);
        if (index) onDone();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Check failed'))
      .finally(() => setBusy(false));
  };

  const badgeClass =
    report?.summary.status === 'ok'
      ? 'badge badge--ok'
      : report?.summary.status === 'attention'
        ? 'badge badge--warn'
        : 'badge badge--fail';

  return (
    <section className="plate">
      <form className="plate__form" onSubmit={submit}>
        <input
          className="plate__input"
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          placeholder="AB12 CDE or ABC 123"
          aria-label="Registration mark"
          maxLength={16}
          autoFocus
        />
        <select
          className="plate__country"
          value={country}
          onChange={(e) => setCountry(e.target.value as '' | 'GB' | 'AU')}
          aria-label="Country"
        >
          <option value="">Auto-detect</option>
          <option value="GB">UK</option>
          <option value="AU">Australia</option>
        </select>
        <button type="submit" className="btn" disabled={busy || input.trim() === ''}>
          {busy ? 'Checking…' : 'Run checks'}
        </button>
      </form>
      <div className="plate__opts">
        <label>
          <input
            type="checkbox"
            checked={vehicle}
            disabled={country === 'AU'}
            onChange={(e) => setVehicle(e.target.checked)}
          />{' '}
          DVLA vehicle data (UK only)
        </label>
        <label>
          <input
            type="checkbox"
            checked={mot}
            disabled={country === 'AU'}
            onChange={(e) => setMot(e.target.checked)}
          />{' '}
          MOT history (UK only)
        </label>
        <label>
          <input type="checkbox" checked={index} onChange={(e) => setIndex(e.target.checked)} />{' '}
          Save to index
        </label>
      </div>

      {error && <p className="notice notice--error">{error}</p>}

      {report && (
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
              <dt>Country</dt>
              <dd>
                {report.country === 'GB' ? 'UK' : report.country === 'AU' ? 'Australia' : 'Unknown'}
              </dd>
            </div>
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
      )}
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
        JSON file — no database, no external services.
      </p>
      <h3>API</h3>
      <ul>
        <li>
          <code>GET /api/search?q=…&amp;tags=…&amp;limit=…&amp;offset=…</code>
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
        For question-like queries the <em>Search</em> tab also weaves a short written answer. It is
        built only from retrieved material — pages in the index plus, when a web-search provider is
        configured, live pages fetched at query time through the same robots / SSRF-guarded stack
        the crawler uses. Every sentence is tied to a numbered source; each source carries a trust
        tier (official / established / unverified reliability) and a fetch or index timestamp.
        Anything the sources do not support is labelled <em>unverified</em>, and a confidence banner
        summarises how well-grounded the answer is. With no LLM configured the answer is a
        deterministic weave of source extracts; with <code>ANTHROPIC_API_KEY</code> (or an
        OpenAI-compatible endpoint) it is written up in prose. All of it is optional.
      </p>
      <h3>Number plate checker</h3>
      <p>
        The <em>Plate check</em> tab runs automatic checks on a UK <em>or Australian</em>{' '}
        registration — country is auto-detected, or pick one explicitly. UK plates get format
        validation, age identifier, DVLA region, and — when API keys are configured — DVLA tax/MOT
        status and DVSA MOT history. Australian plates get structural format validation against the
        common current state shapes; Australia has no national scheme encoding the issuing state in
        the plate itself (unlike the UK's DVLA memory tags), so the state is reported as a hint, not
        a determination. Offline checks need no credentials either way.
      </p>
      <h3>CLI &amp; MCP</h3>
      <p>
        <code>beacon serve|add|import|crawl|search|stats</code>,{' '}
        <code>beacon plate &quot;AB12 CDE&quot;</code> (or{' '}
        <code>beacon plate &quot;ABC 123&quot; --country AU</code>). An MCP server (
        <code>beacon-mcp</code>) exposes the plate checker and the search index as tools for Claude
        and other MCP clients.
      </p>
    </section>
  );
}
