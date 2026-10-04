// Central metadata for every setting shown in Settings — both the ones that
// only ever live in this browser (General/most of Search/most of Privacy)
// and the ones backed by the server (GET/PATCH /api/settings). This file
// renders the controls, supplies defaults, and drives reset-to-default and
// the settings search box; it does not itself store values — client-scoped
// values live in `useClientSettings` (localStorage), server-scoped values
// come from `/api/settings` and are edited through the same endpoint.

// 'sources' has no registry entries of its own — that section renders live
// from GET /api/providers instead — but it's still a real navigable section.
export type SettingSection = 'general' | 'search' | 'sources' | 'ai' | 'privacy' | 'advanced';
export type SettingType = 'toggle' | 'select' | 'text' | 'number';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDefinition {
  id: string;
  section: SettingSection;
  /** Also render this control in another section (e.g. "direct answers" in both Search and AI). */
  alsoShowIn?: SettingSection[];
  label: string;
  description?: string;
  type: SettingType;
  /** 'client' settings persist to localStorage only; 'server' settings call /api/settings. */
  scope: 'client' | 'server';
  defaultValue?: unknown;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  advanced?: boolean;
  requiresRestart?: boolean;
}

export const CLIENT_SETTINGS: SettingDefinition[] = [
  {
    id: 'region',
    section: 'general',
    label: 'Region',
    description: 'Used to format dates/numbers in the interface. Does not change which data sources are used.',
    type: 'select',
    scope: 'client',
    defaultValue: 'AU',
    options: [
      { value: 'AU', label: 'Australia' },
      { value: 'UK', label: 'United Kingdom' },
      { value: 'US', label: 'United States' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    id: 'language',
    section: 'general',
    label: 'Language',
    description: 'Interface language. Only English is available today.',
    type: 'select',
    scope: 'client',
    defaultValue: 'en',
    options: [{ value: 'en', label: 'English' }],
  },
  {
    id: 'resultsPerPage',
    section: 'general',
    label: 'Results per page',
    type: 'select',
    scope: 'client',
    defaultValue: 10,
    options: [
      { value: '5', label: '5' },
      { value: '10', label: '10' },
      { value: '20', label: '20' },
      { value: '50', label: '50' },
    ],
  },
  {
    id: 'openInNewTab',
    section: 'general',
    label: 'Open results in a new tab',
    type: 'toggle',
    scope: 'client',
    defaultValue: true,
  },
  {
    id: 'interfaceDensity',
    section: 'general',
    label: 'Interface density',
    type: 'select',
    scope: 'client',
    defaultValue: 'comfortable',
    options: [
      { value: 'comfortable', label: 'Comfortable' },
      { value: 'compact', label: 'Compact' },
    ],
  },
  {
    id: 'searchMode',
    section: 'search',
    label: 'Search mode',
    description:
      'Precise requires every word to match exactly. Broad matches on any word. Balanced (default) requires every word, but falls back to a partial match rather than showing nothing.',
    type: 'select',
    scope: 'client',
    defaultValue: 'balanced',
    options: [
      { value: 'precise', label: 'Precise' },
      { value: 'balanced', label: 'Balanced' },
      { value: 'broad', label: 'Broad' },
    ],
  },
  {
    id: 'freshness',
    section: 'search',
    label: 'Prioritise newest results',
    description: 'Sort by most recently added/updated instead of relevance.',
    type: 'toggle',
    scope: 'client',
    defaultValue: false,
  },
  {
    id: 'queryExpansion',
    section: 'search',
    label: 'Query expansion',
    description: 'When no result matches every word, show the closest partial match instead of nothing.',
    type: 'toggle',
    scope: 'client',
    defaultValue: true,
  },
  {
    id: 'typoCorrection',
    section: 'search',
    label: 'Typo correction',
    description: 'Allow fuzzy matching for close misspellings.',
    type: 'toggle',
    scope: 'client',
    defaultValue: true,
  },
  {
    id: 'citationsVisible',
    section: 'ai',
    label: 'Show citations',
    description: 'Show the numbered [n] source markers inline in generated answers.',
    type: 'toggle',
    scope: 'client',
    defaultValue: true,
  },
  {
    id: 'saveSearchHistory',
    section: 'privacy',
    label: 'Save search history',
    description: 'Keep a local record of your recent queries, stored only in this browser.',
    type: 'toggle',
    scope: 'client',
    defaultValue: true,
  },
  {
    id: 'historyRetentionDays',
    section: 'privacy',
    label: 'History retention',
    type: 'select',
    scope: 'client',
    defaultValue: 30,
    options: [
      { value: '7', label: '7 days' },
      { value: '30', label: '30 days' },
      { value: '90', label: '90 days' },
      { value: '0', label: 'Keep forever' },
    ],
  },
];

/**
 * Server-backed settings, matching `RUNTIME_SETTINGS` in
 * `src/core/runtime-settings.ts` by id. Kept as a separate, hand-maintained
 * list rather than a shared import: the frontend bundle only ever pulls in
 * `@core` types (erased at build time), never backend runtime code, so the
 * two sides describe the same ~19 fields independently. Labels/descriptions
 * here are the user-facing wording; the backend's are the technical ones
 * shown in its own API responses.
 */
export const SERVER_SETTINGS: SettingDefinition[] = [
  {
    id: 'answerAutoAnswer',
    section: 'ai',
    alsoShowIn: ['search'],
    label: 'Generate answers from search results',
    description: 'Automatically weave a cited answer for question-like queries.',
    type: 'toggle',
    scope: 'server',
  },
  {
    id: 'answerMaxSources',
    section: 'ai',
    label: 'Maximum sources',
    description: 'How many sources a single answer can cite. Higher values scrape more pages per answer.',
    type: 'number',
    scope: 'server',
    min: 1,
    max: 50,
  },
  {
    id: 'answerPreferredLlm',
    section: 'ai',
    label: 'Preferred model',
    description: 'Which configured model to try first when more than one is set up.',
    type: 'select',
    scope: 'server',
    options: [
      { value: '', label: 'Automatic' },
      { value: 'anthropic', label: 'Anthropic' },
      { value: 'openai', label: 'OpenAI-compatible' },
    ],
  },
  {
    id: 'lookupsEnabled',
    section: 'advanced',
    label: 'Domain / IP lookups',
    description: 'Resolve DNS + RDAP data for a bare domain or IP typed into the search box.',
    type: 'toggle',
    scope: 'server',
  },
  {
    id: 'plateIndexResults',
    section: 'advanced',
    label: 'Save plate checks to the index',
    type: 'toggle',
    scope: 'server',
  },
  {
    id: 'answerStripTrackingParams',
    section: 'privacy',
    label: 'Strip tracking parameters',
    description: 'Remove utm_*/fbclid/gclid-style tracking params from cited web URLs.',
    type: 'toggle',
    scope: 'server',
  },
  {
    id: 'answerEnabled',
    section: 'advanced',
    label: 'Answer engine (master switch)',
    description: 'Disables GET /api/answer entirely. Turning it back on after a cold start needs a restart.',
    type: 'toggle',
    scope: 'server',
    advanced: true,
    requiresRestart: true,
  },
  {
    id: 'lookupsTimeoutMs',
    section: 'advanced',
    label: 'Lookup timeout (ms)',
    type: 'number',
    scope: 'server',
    advanced: true,
    min: 1000,
    max: 30000,
  },
  {
    id: 'answerTrustedDomains',
    section: 'advanced',
    label: 'Extra trusted domains',
    description: 'Comma-separated domains promoted to the "official" trust tier.',
    type: 'text',
    scope: 'server',
    advanced: true,
  },
  {
    id: 'crawlMaxPages',
    section: 'advanced',
    label: 'Max pages per crawl',
    type: 'number',
    scope: 'server',
    advanced: true,
    min: 1,
    max: 5000,
  },
  {
    id: 'crawlConcurrency',
    section: 'advanced',
    label: 'Crawl concurrency',
    type: 'number',
    scope: 'server',
    advanced: true,
    min: 1,
    max: 32,
  },
  {
    id: 'crawlTimeoutMs',
    section: 'advanced',
    label: 'Crawl page timeout (ms)',
    type: 'number',
    scope: 'server',
    advanced: true,
    min: 1000,
    max: 60000,
  },
  {
    id: 'crawlDelayMs',
    section: 'advanced',
    label: 'Crawl delay (ms)',
    type: 'number',
    scope: 'server',
    advanced: true,
    min: 0,
    max: 10000,
  },
  {
    id: 'crawlAllowPrivateHosts',
    section: 'advanced',
    label: 'Allow crawling private hosts',
    description: 'Off is the safe default (SSRF guard).',
    type: 'toggle',
    scope: 'server',
    advanced: true,
  },
  {
    id: 'plateTimeoutMs',
    section: 'advanced',
    label: 'Vehicle data timeout (ms)',
    type: 'number',
    scope: 'server',
    advanced: true,
    requiresRestart: true,
    min: 1000,
    max: 30000,
  },
  {
    id: 'answerFetchTimeoutMs',
    section: 'advanced',
    label: 'Source fetch timeout (ms)',
    type: 'number',
    scope: 'server',
    advanced: true,
    min: 1000,
    max: 30000,
  },
  {
    id: 'answerLlmTimeoutMs',
    section: 'advanced',
    label: 'Model timeout (ms)',
    type: 'number',
    scope: 'server',
    advanced: true,
    min: 1000,
    max: 120000,
  },
  {
    id: 'rateLimitMax',
    section: 'advanced',
    label: 'Rate limit (requests)',
    description: '0 disables it.',
    type: 'number',
    scope: 'server',
    advanced: true,
    requiresRestart: true,
    min: 0,
    max: 100000,
  },
  {
    id: 'rateLimitWindowMs',
    section: 'advanced',
    label: 'Rate limit window (ms)',
    type: 'number',
    scope: 'server',
    advanced: true,
    requiresRestart: true,
    min: 1000,
    max: 3600000,
  },
  {
    id: 'persistDebounceMs',
    section: 'advanced',
    label: 'Index save delay (ms)',
    type: 'number',
    scope: 'server',
    advanced: true,
    requiresRestart: true,
    min: 0,
    max: 60000,
  },
];

export const ALL_SETTINGS: SettingDefinition[] = [...CLIENT_SETTINGS, ...SERVER_SETTINGS];

export function settingsInSection(section: SettingSection): SettingDefinition[] {
  return ALL_SETTINGS.filter((d) => d.section === section || d.alsoShowIn?.includes(section));
}

/** Case-insensitive match against a setting's id/label/description — powers the "Search settings…" box. */
export function searchSettings(query: string): SettingDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return ALL_SETTINGS.filter(
    (d) =>
      d.label.toLowerCase().includes(q) ||
      d.description?.toLowerCase().includes(q) ||
      d.id.toLowerCase().includes(q),
  );
}
