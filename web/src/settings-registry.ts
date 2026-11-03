// Browser-only settings. Server settings are not copied here: the Settings
// screen renders them from GET /api/settings (label, type, min, max, section,
// requiresRestart). This file supplies defaults for the local prefs and the
// small amount of placement the API section enum cannot express.

// 'sources' renders live from GET /api/settings (section "sources") plus
// GET /api/providers.
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
    description:
      'Used to format dates/numbers in the interface. Does not change which data sources are used.',
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
    description:
      'When no result matches every word, show the closest partial match instead of nothing.',
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
    id: 'prefixMatch',
    section: 'search',
    label: 'Match word prefixes',
    description:
      'Treat the start of a word as a match, so searching “perform” can find “performance”.',
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
 * Sections a server setting should also appear in. The API's own `section`
 * is the primary place. Keys must be `RUNTIME_SETTINGS` ids.
 */
export const SERVER_ALSO_SHOW: Partial<Record<string, SettingSection[]>> = {
  answerAutoAnswer: ['search'],
};

export interface ServerSettingEntry {
  id: string;
  label: string;
  description: string;
  type: 'toggle' | 'number' | 'text';
  section: 'sources' | 'ai' | 'advanced';
  advanced: boolean;
  requiresRestart: boolean;
  min?: number;
  max?: number;
  value: boolean | number | string;
}

/** Preferred-model choices built from the providers `/health` says are configured. */
export function preferredModelOptions(llmNames: readonly string[]): SettingOption[] {
  const options: SettingOption[] = [{ value: '', label: 'Automatic' }];
  for (const name of llmNames) {
    if (/anthropic/i.test(name) && !options.some((o) => o.value === 'anthropic')) {
      options.push({ value: 'anthropic', label: name });
    } else if (/openai/i.test(name) && !options.some((o) => o.value === 'openai')) {
      options.push({ value: 'openai', label: name });
    }
  }
  return options;
}

/** Turn one GET /api/settings row into the control the Settings screen renders. */
export function serverEntryToDefinition(
  entry: ServerSettingEntry,
  llmNames: readonly string[] = [],
): SettingDefinition {
  const section: SettingSection =
    entry.section === 'sources' || entry.section === 'ai' || entry.section === 'advanced'
      ? entry.section
      : 'advanced';
  const preferred = entry.id === 'answerPreferredLlm';
  const options = preferred ? preferredModelOptions(llmNames) : undefined;
  if (preferred && options) {
    const current = String(entry.value ?? '');
    if (current && !options.some((option) => option.value === current)) {
      options.push({ value: current, label: current });
    }
  }
  return {
    id: entry.id,
    section,
    alsoShowIn: SERVER_ALSO_SHOW[entry.id],
    label: entry.label,
    description: entry.description,
    type: preferred ? 'select' : entry.type,
    scope: 'server',
    options,
    min: entry.min,
    max: entry.max,
    advanced: entry.advanced,
    requiresRestart: entry.requiresRestart,
  };
}

export function inSection(def: SettingDefinition, section: SettingSection): boolean {
  return def.section === section || Boolean(def.alsoShowIn?.includes(section));
}

export function clientSettingsInSection(section: SettingSection): SettingDefinition[] {
  return CLIENT_SETTINGS.filter((d) => inSection(d, section));
}

function matchesQuery(def: SettingDefinition, q: string): boolean {
  return (
    def.label.toLowerCase().includes(q) ||
    Boolean(def.description?.toLowerCase().includes(q)) ||
    def.id.toLowerCase().includes(q)
  );
}

/** Case-insensitive match against client settings plus the live server rows. */
export function searchSettings(
  query: string,
  server: SettingDefinition[] = [],
): SettingDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return [...CLIENT_SETTINGS, ...server].filter((d) => matchesQuery(d, q));
}
