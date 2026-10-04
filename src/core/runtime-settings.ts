import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type Config } from './config.js';
import type { Logger } from './logger.js';

export type RuntimeSettingType = 'toggle' | 'number' | 'text';

/**
 * One server-side setting that's safe to change without redeploying — a real
 * field already read from `Config`, never a fabricated knob. `get`/`set` read
 * and write the live `Config` object directly (its nested objects are shared
 * by reference with every service built from it), so most of these take
 * effect on the very next request; the few that are baked into a constructor
 * at boot (a provider's own timeout, the rate-limit plugin, the engine's
 * save-debounce) are marked `requiresRestart`.
 */
export interface RuntimeSettingDefinition {
  id: string;
  label: string;
  description: string;
  type: RuntimeSettingType;
  /** Loose grouping for the GET /api/settings response; the UI may regroup. */
  section: 'sources' | 'ai' | 'advanced';
  advanced: boolean;
  requiresRestart: boolean;
  min?: number;
  max?: number;
  get(config: Config): boolean | number | string;
  set(config: Config, value: boolean | number | string): void;
}

export const RUNTIME_SETTINGS: RuntimeSettingDefinition[] = [
  {
    id: 'lookupsEnabled',
    label: 'Domain / IP lookups',
    description: 'Resolve DNS + RDAP data for a bare domain or IP typed into the search box.',
    type: 'toggle',
    section: 'sources',
    advanced: false,
    requiresRestart: false,
    get: (c) => c.lookups.enabled,
    set: (c, v) => {
      c.lookups.enabled = Boolean(v);
    },
  },
  {
    id: 'lookupsTimeoutMs',
    label: 'Lookup timeout',
    description: 'How long to wait for a DNS/RDAP response before giving up.',
    type: 'number',
    min: 1_000,
    max: 30_000,
    section: 'advanced',
    advanced: true,
    requiresRestart: false,
    get: (c) => c.lookups.timeoutMs,
    set: (c, v) => {
      c.lookups.timeoutMs = Number(v);
    },
  },
  {
    id: 'plateIndexResults',
    label: 'Save plate checks to the index',
    description: 'Automatically index every number-plate check so it becomes searchable.',
    type: 'toggle',
    section: 'sources',
    advanced: false,
    requiresRestart: false,
    get: (c) => c.plate.indexResults,
    set: (c, v) => {
      c.plate.indexResults = Boolean(v);
    },
  },
  {
    id: 'plateTimeoutMs',
    label: 'Vehicle data timeout',
    description: 'Timeout for the DVLA/DVSA HTTP calls. Baked into the provider at boot.',
    type: 'number',
    min: 1_000,
    max: 30_000,
    section: 'advanced',
    advanced: true,
    requiresRestart: true,
    get: (c) => c.plate.timeoutMs,
    set: (c, v) => {
      c.plate.timeoutMs = Number(v);
    },
  },
  {
    id: 'crawlMaxPages',
    label: 'Max pages per crawl',
    description: 'Upper bound on pages fetched by a single crawl.',
    type: 'number',
    min: 1,
    max: 5_000,
    section: 'advanced',
    advanced: true,
    requiresRestart: false,
    get: (c) => c.crawlMaxPages,
    set: (c, v) => {
      c.crawlMaxPages = Number(v);
    },
  },
  {
    id: 'crawlConcurrency',
    label: 'Crawl concurrency',
    description: 'How many pages the crawler fetches in parallel.',
    type: 'number',
    min: 1,
    max: 32,
    section: 'advanced',
    advanced: true,
    requiresRestart: false,
    get: (c) => c.crawlConcurrency,
    set: (c, v) => {
      c.crawlConcurrency = Number(v);
    },
  },
  {
    id: 'crawlTimeoutMs',
    label: 'Crawl page timeout',
    description: 'Timeout per page fetch during a crawl.',
    type: 'number',
    min: 1_000,
    max: 60_000,
    section: 'advanced',
    advanced: true,
    requiresRestart: false,
    get: (c) => c.crawlTimeoutMs,
    set: (c, v) => {
      c.crawlTimeoutMs = Number(v);
    },
  },
  {
    id: 'crawlDelayMs',
    label: 'Crawl delay',
    description: 'Pause between requests to the same host during a crawl.',
    type: 'number',
    min: 0,
    max: 10_000,
    section: 'advanced',
    advanced: true,
    requiresRestart: false,
    get: (c) => c.crawlDelayMs,
    set: (c, v) => {
      c.crawlDelayMs = Number(v);
    },
  },
  {
    id: 'crawlAllowPrivateHosts',
    label: 'Allow crawling private hosts',
    description: 'Lets crawling reach loopback/private addresses. Off is the safe default (SSRF guard).',
    type: 'toggle',
    section: 'advanced',
    advanced: true,
    requiresRestart: false,
    get: (c) => c.crawlAllowPrivateHosts,
    set: (c, v) => {
      c.crawlAllowPrivateHosts = Boolean(v);
    },
  },
  {
    id: 'answerAutoAnswer',
    label: 'Generate answers from search results',
    description: 'Automatically weave a cited answer for question-like queries.',
    type: 'toggle',
    section: 'ai',
    advanced: false,
    requiresRestart: false,
    get: (c) => c.answer.autoAnswer,
    set: (c, v) => {
      c.answer.autoAnswer = Boolean(v);
    },
  },
  {
    id: 'answerEnabled',
    label: 'Answer engine',
    description: 'Master switch for answer synthesis. Turning this on after it started disabled needs a restart.',
    type: 'toggle',
    section: 'advanced',
    advanced: true,
    requiresRestart: true,
    get: (c) => c.answer.enabled,
    set: (c, v) => {
      c.answer.enabled = Boolean(v);
    },
  },
  {
    id: 'answerMaxSources',
    label: 'Maximum sources',
    description: 'How many sources a single answer can cite. Higher values scrape more pages per answer.',
    type: 'number',
    min: 1,
    max: 50,
    section: 'ai',
    advanced: false,
    requiresRestart: false,
    get: (c) => c.answer.maxSources,
    set: (c, v) => {
      c.answer.maxSources = Number(v);
    },
  },
  {
    id: 'answerFetchTimeoutMs',
    label: 'Source fetch timeout',
    description: 'Timeout for fetching a single web source, or running a web search.',
    type: 'number',
    min: 1_000,
    max: 30_000,
    section: 'advanced',
    advanced: true,
    requiresRestart: false,
    get: (c) => c.answer.fetchTimeoutMs,
    set: (c, v) => {
      c.answer.fetchTimeoutMs = Number(v);
    },
  },
  {
    id: 'answerLlmTimeoutMs',
    label: 'Model timeout',
    description: 'Timeout for the LLM synthesis call.',
    type: 'number',
    min: 1_000,
    max: 120_000,
    section: 'advanced',
    advanced: true,
    requiresRestart: false,
    get: (c) => c.answer.llmTimeoutMs,
    set: (c, v) => {
      c.answer.llmTimeoutMs = Number(v);
    },
  },
  {
    id: 'answerPreferredLlm',
    label: 'Preferred model',
    description: 'Which configured model to try first when more than one is set up.',
    type: 'text',
    section: 'ai',
    advanced: false,
    requiresRestart: false,
    get: (c) => c.answer.preferredLlm ?? '',
    set: (c, v) => {
      const s = String(v);
      c.answer.preferredLlm = s === 'anthropic' || s === 'openai' ? s : undefined;
    },
  },
  {
    id: 'answerTrustedDomains',
    label: 'Extra trusted domains',
    description: 'Comma-separated domains promoted to the "official" trust tier.',
    type: 'text',
    section: 'advanced',
    advanced: true,
    requiresRestart: false,
    get: (c) => c.answer.trustedDomains.join(', '),
    set: (c, v) => {
      c.answer.trustedDomains = String(v)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    },
  },
  {
    id: 'answerStripTrackingParams',
    label: 'Strip tracking parameters',
    description: 'Remove utm_*/fbclid/gclid-style tracking params from cited web URLs.',
    type: 'toggle',
    section: 'advanced',
    advanced: true,
    requiresRestart: false,
    get: (c) => c.answer.stripTrackingParams,
    set: (c, v) => {
      c.answer.stripTrackingParams = Boolean(v);
    },
  },
  {
    id: 'rateLimitMax',
    label: 'Rate limit (requests)',
    description: 'Max requests per IP per window across the whole API. 0 disables it.',
    type: 'number',
    min: 0,
    max: 100_000,
    section: 'advanced',
    advanced: true,
    requiresRestart: true,
    get: (c) => c.rateLimit.max,
    set: (c, v) => {
      c.rateLimit.max = Number(v);
    },
  },
  {
    id: 'rateLimitWindowMs',
    label: 'Rate limit window',
    description: 'The window the request limit applies over.',
    type: 'number',
    min: 1_000,
    max: 3_600_000,
    section: 'advanced',
    advanced: true,
    requiresRestart: true,
    get: (c) => c.rateLimit.windowMs,
    set: (c, v) => {
      c.rateLimit.windowMs = Number(v);
    },
  },
  {
    id: 'persistDebounceMs',
    label: 'Index save delay',
    description: 'Delay before flushing index changes to disk.',
    type: 'number',
    min: 0,
    max: 60_000,
    section: 'advanced',
    advanced: true,
    requiresRestart: true,
    get: (c) => c.persistDebounceMs,
    set: (c, v) => {
      c.persistDebounceMs = Number(v);
    },
  },
];

function definitionFor(id: string): RuntimeSettingDefinition | undefined {
  return RUNTIME_SETTINGS.find((d) => d.id === id);
}

function validateValue(
  def: RuntimeSettingDefinition,
  raw: unknown,
): { value: boolean | number | string } | { error: string } {
  if (def.type === 'toggle') {
    if (typeof raw !== 'boolean') return { error: 'must be a boolean' };
    return { value: raw };
  }
  if (def.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return { error: 'must be a number' };
    if (def.min !== undefined && n < def.min) return { error: `must be >= ${def.min}` };
    if (def.max !== undefined && n > def.max) return { error: `must be <= ${def.max}` };
    return { value: n };
  }
  if (typeof raw !== 'string') return { error: 'must be a string' };
  if (raw.length > 2048) return { error: 'too long' };
  return { value: raw };
}

export interface RuntimeSettingsStoreOptions {
  file: string;
  config: Config;
  logger?: Logger;
}

/**
 * Loads/persists a JSON overlay of {@link RUNTIME_SETTINGS} on top of the
 * environment-derived `Config`, the same atomic-write pattern `store.ts` uses
 * for the search index. `set()` mutates the live `Config` object in place —
 * every service holding a reference to it (or its nested `lookups`/`plate`/
 * `answer` objects) observes the change on its next read.
 */
export class RuntimeSettingsStore {
  private readonly file: string;
  private readonly config: Config;
  private readonly logger?: Logger;
  private overrides: Record<string, boolean | number | string> = {};

  constructor(options: RuntimeSettingsStoreOptions) {
    this.file = path.resolve(options.file);
    this.config = options.config;
    this.logger = options.logger;
  }

  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return;
      for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
        const def = definitionFor(id);
        if (!def) continue;
        const validated = validateValue(def, raw);
        if ('error' in validated) continue;
        def.set(this.config, validated.value);
        this.overrides[id] = validated.value;
      }
      this.logger?.info(
        { file: this.file, overrides: Object.keys(this.overrides).length },
        'settings overlay loaded',
      );
    } catch (error) {
      this.logger?.error({ err: error, file: this.file }, 'failed to load settings overlay; using defaults');
    }
  }

  /** Current effective value + metadata for every registered setting. */
  list(): Array<RuntimeSettingDefinition & { value: boolean | number | string; isDefault: boolean }> {
    return RUNTIME_SETTINGS.map((def) => ({
      ...def,
      value: def.get(this.config),
      isDefault: !(def.id in this.overrides),
    }));
  }

  /** Apply a partial update, validating each id/value, and persist what applied. */
  async update(
    patch: Record<string, unknown>,
  ): Promise<{ applied: string[]; errors: Record<string, string> }> {
    const applied: string[] = [];
    const errors: Record<string, string> = {};
    for (const [id, raw] of Object.entries(patch)) {
      const def = definitionFor(id);
      if (!def) {
        errors[id] = 'unknown setting';
        continue;
      }
      const validated = validateValue(def, raw);
      if ('error' in validated) {
        errors[id] = validated.error;
        continue;
      }
      def.set(this.config, validated.value);
      this.overrides[id] = validated.value;
      applied.push(id);
    }
    if (applied.length > 0) await this.persist();
    return { applied, errors };
  }

  /** Reset the given ids (or every setting, if omitted) back to its environment-derived default. */
  async reset(ids?: string[]): Promise<string[]> {
    const fresh = loadConfig();
    const targets = ids ?? RUNTIME_SETTINGS.map((d) => d.id);
    const resetIds: string[] = [];
    for (const id of targets) {
      const def = definitionFor(id);
      if (!def) continue;
      def.set(this.config, def.get(fresh));
      delete this.overrides[id];
      resetIds.push(id);
    }
    await this.persist();
    return resetIds;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.overrides, null, 2), 'utf8');
    await rename(tmp, this.file);
    this.logger?.debug({ file: this.file }, 'settings overlay persisted');
  }
}
