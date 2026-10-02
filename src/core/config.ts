import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  indexFile: string;
  webDir: string;
  logLevel: string;
  logPretty: boolean;
  corsOrigin: string | boolean;
  persistDebounceMs: number;
  crawlUserAgent: string;
  crawlMaxPages: number;
  crawlConcurrency: number;
  crawlTimeoutMs: number;
  crawlDelayMs: number;
  crawlAllowPrivateHosts: boolean;
  maxBodyBytes: number;
  plate: PlateConfig;
  answer: AnswerConfig;
  lookups: LookupsConfig;
  rateLimit: RateLimitConfig;
}

export interface RateLimitConfig {
  /** Max requests per IP per window on /api/*. 0 disables rate limiting entirely. */
  max: number;
  windowMs: number;
}

export interface LookupsConfig {
  /** Master switch for the universal box's domain/IP lookups (DNS + RDAP). */
  enabled: boolean;
  /** Per-request timeout for the DNS / RDAP calls (ms). */
  timeoutMs: number;
}

export interface AnswerConfig {
  /** Master switch for the answer-weave layer and `GET /api/answer`. */
  enabled: boolean;
  /** Whether the web UI auto-answers question-like queries. */
  autoAnswer: boolean;
  anthropicApiKey?: string;
  anthropicModel: string;
  openaiApiKey?: string;
  openaiBaseUrl: string;
  openaiModel?: string;
  /** Which web-search provider to use, if any. */
  webSearch?: 'brave' | 'tavily' | 'searxng';
  braveApiKey?: string;
  tavilyApiKey?: string;
  searxngUrl?: string;
  /** Maximum number of sources gathered per answer. */
  maxSources: number;
  /** Per-request timeout for fetching a source page / web search (ms). */
  fetchTimeoutMs: number;
  /** Timeout for the LLM synthesis call (ms). */
  llmTimeoutMs: number;
  /** Extra domains promoted to the `official` trust tier. */
  trustedDomains: string[];
  /** Allow fetching sources on loopback / private hosts (SSRF guard). */
  allowPrivateHosts: boolean;
}

export interface PlateConfig {
  dvlaVesApiKey?: string;
  dvlaVesBaseUrl?: string;
  motClientId?: string;
  motClientSecret?: string;
  motApiKey?: string;
  motTokenUrl?: string;
  motScope?: string;
  motBaseUrl?: string;
  /** Per-request timeout for the DVLA / DVSA HTTP calls (ms). */
  timeoutMs: number;
  /** Index each plate check into the search engine as a document. */
  indexResults: boolean;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/**
 * Read an optional string, accepting both the `BEACON_`-prefixed name and the
 * bare name (the plate provider vars are commonly set with their DVLA/DVSA
 * spelling, e.g. `DVLA_VES_API_KEY`).
 */
function readOptional(name: string): string | undefined {
  const raw = process.env[`BEACON_${name}`] ?? process.env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

export interface ConfigOverrides
  extends Partial<Omit<Config, 'plate' | 'answer' | 'lookups' | 'rateLimit'>> {
  plate?: Partial<PlateConfig>;
  answer?: Partial<AnswerConfig>;
  lookups?: Partial<LookupsConfig>;
  rateLimit?: Partial<RateLimitConfig>;
}

const WEB_SEARCH_PROVIDERS = ['brave', 'tavily', 'searxng'] as const;

function readWebSearchProvider(): AnswerConfig['webSearch'] {
  const raw = readOptional('ANSWER_WEB_SEARCH')?.toLowerCase();
  return (WEB_SEARCH_PROVIDERS as readonly string[]).includes(raw ?? '')
    ? (raw as AnswerConfig['webSearch'])
    : undefined;
}

function readList(name: string): string[] {
  const raw = readOptional(name);
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Resolve runtime configuration from environment variables, applying safe
 * defaults so the app runs with zero configuration in any environment.
 */
export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const cwd = process.cwd();
  const dataDir = path.resolve(cwd, readString('BEACON_DATA_DIR', 'data'));
  const nodeEnv = process.env.NODE_ENV ?? 'development';

  const base: Config = {
    host: readString('BEACON_HOST', '0.0.0.0'),
    port: readInt('BEACON_PORT', readInt('PORT', 7700)),
    dataDir,
    indexFile: path.resolve(cwd, readString('BEACON_INDEX_FILE', path.join(dataDir, 'index.json'))),
    webDir: path.resolve(cwd, readString('BEACON_WEB_DIR', 'web/dist')),
    logLevel: readString('BEACON_LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info'),
    logPretty: readBool('BEACON_LOG_PRETTY', nodeEnv === 'development'),
    corsOrigin: readString('BEACON_CORS_ORIGIN', '') || true,
    persistDebounceMs: readInt('BEACON_PERSIST_DEBOUNCE_MS', 750),
    crawlUserAgent: readString(
      'BEACON_CRAWL_USER_AGENT',
      'BeaconSearchBot/1.0 (+https://github.com/abbieymatthews030-star/abeaconsearch)',
    ),
    crawlMaxPages: readInt('BEACON_CRAWL_MAX_PAGES', 50),
    crawlConcurrency: readInt('BEACON_CRAWL_CONCURRENCY', 4),
    crawlTimeoutMs: readInt('BEACON_CRAWL_TIMEOUT_MS', 15_000),
    crawlDelayMs: readInt('BEACON_CRAWL_DELAY_MS', 150),
    crawlAllowPrivateHosts: readBool('BEACON_CRAWL_ALLOW_PRIVATE', false),
    maxBodyBytes: readInt('BEACON_MAX_BODY_BYTES', 8 * 1024 * 1024),
    plate: {
      dvlaVesApiKey: readOptional('DVLA_VES_API_KEY'),
      dvlaVesBaseUrl: readOptional('DVLA_VES_BASE_URL'),
      motClientId: readOptional('MOT_CLIENT_ID'),
      motClientSecret: readOptional('MOT_CLIENT_SECRET'),
      motApiKey: readOptional('MOT_API_KEY'),
      motTokenUrl: readOptional('MOT_TOKEN_URL'),
      motScope: readOptional('MOT_SCOPE'),
      motBaseUrl: readOptional('MOT_BASE_URL'),
      timeoutMs: readInt('BEACON_PLATE_TIMEOUT_MS', 12_000),
      indexResults: readBool('BEACON_PLATE_INDEX_RESULTS', false),
    },
    answer: {
      enabled: readBool('BEACON_ANSWER_ENABLED', true),
      autoAnswer: readBool('BEACON_ANSWER_AUTO', true),
      anthropicApiKey: readOptional('ANTHROPIC_API_KEY'),
      anthropicModel: readString('BEACON_ANSWER_ANTHROPIC_MODEL', 'claude-opus-5'),
      openaiApiKey: readOptional('OPENAI_API_KEY'),
      openaiBaseUrl:
        readOptional('OPENAI_BASE_URL') ??
        readOptional('ANSWER_OPENAI_BASE_URL') ??
        'https://api.openai.com/v1',
      openaiModel: readOptional('ANSWER_OPENAI_MODEL'),
      webSearch: readWebSearchProvider(),
      braveApiKey: readOptional('BRAVE_SEARCH_API_KEY'),
      tavilyApiKey: readOptional('TAVILY_API_KEY'),
      searxngUrl: readOptional('SEARXNG_URL'),
      maxSources: readInt('BEACON_ANSWER_MAX_SOURCES', 8),
      fetchTimeoutMs: readInt('BEACON_ANSWER_FETCH_TIMEOUT_MS', 8_000),
      llmTimeoutMs: readInt('BEACON_ANSWER_LLM_TIMEOUT_MS', 30_000),
      trustedDomains: readList('ANSWER_TRUSTED_DOMAINS'),
      allowPrivateHosts: readBool('BEACON_ANSWER_ALLOW_PRIVATE', false),
    },
    lookups: {
      enabled: readBool('BEACON_LOOKUPS_ENABLED', true),
      timeoutMs: readInt('BEACON_LOOKUPS_TIMEOUT_MS', 8_000),
    },
    rateLimit: {
      max: readInt('BEACON_RATE_LIMIT_MAX', 200),
      windowMs: readInt('BEACON_RATE_LIMIT_WINDOW_MS', 60_000),
    },
  };

  // `plate` / `answer` / `lookups` / `rateLimit` are merged rather than
  // replaced so callers can override a single nested field without restating
  // the whole sub-config.
  return {
    ...base,
    ...overrides,
    plate: { ...base.plate, ...overrides.plate },
    answer: { ...base.answer, ...overrides.answer },
    lookups: { ...base.lookups, ...overrides.lookups },
    rateLimit: { ...base.rateLimit, ...overrides.rateLimit },
  };
}
