import { isFunctionWord } from './relevance.js';
import type { SearchAction, SearchIntent } from './types.js';

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/i;
const CALCULATION_RE = /^[-+]?[\d\s().]+(?:[-+*/^%][-+]?[\d\s().]+)+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d(][\d\s().-]{6,}\d$/;
const USERNAME_RE = /^[@/][A-Za-z0-9._-]{2,32}$/;
const PLATE_RE = /^plate\s+\S+/i;
const QUESTION_RE =
  /^(who|what|whats|when|where|why|how|is|are|was|were|does|do|did|can|could|should|would|will|which|whom|whose|define|explain|tell)\b/i;
const COMPANY_RE = /\b(inc|llc|ltd|gmbh|corp|corporation|company|plc|limited)\b\.?$/i;
const LOCATION_RE = /\b(near|nearby|outside|postcode|zip code|postal code|located in|based in)\b/i;
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

/** Words that make a short query read as a topic, not a person's name. */
const NOT_A_NAME = new Set([
  'hooks',
  'guide',
  'guides',
  'tutorial',
  'tutorials',
  'docs',
  'documentation',
  'api',
  'apis',
  'setup',
  'config',
  'configuration',
  'framework',
  'frameworks',
  'library',
  'libraries',
  'basics',
  'overview',
  'introduction',
  'intro',
  'review',
  'reviews',
  'news',
  'weather',
  'recipe',
  'recipes',
  'search',
  'index',
  'ranking',
  'crawler',
  'server',
  'react',
  'nodejs',
  'node',
  'fastify',
  'typescript',
  'javascript',
  'python',
  'minisearch',
  'beacon',
  'battery',
  'bread',
  'linux',
  'windows',
  'github',
  'http',
  'https',
]);

export function stripQuotes(query: string): string {
  return query
    .trim()
    .replace(/^["“]+|["”]+$/g, '')
    .trim();
}

function isIpAddress(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every((part) => {
      const n = Number(part);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  const colons = value.match(/:/g)?.length ?? 0;
  return colons >= 2 && /^[0-9a-f:]+$/i.test(value);
}

function looksLikePerson(query: string): boolean {
  const words = stripQuotes(query).split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => {
    if (!/^[\p{L}][\p{L}'-]{1,}$/u.test(word)) return false;
    const lower = word.toLowerCase();
    return !isFunctionWord(lower) && !NOT_A_NAME.has(lower);
  });
}

/** Classify a search-box query so providers and fallbacks can be chosen without a manual source picker. */
export function detectIntent(raw: string): SearchIntent {
  const q = raw.trim();
  if (!q) return 'general';
  if (PLATE_RE.test(q)) return 'plate';
  if (EMAIL_RE.test(q)) return 'email';
  if (PHONE_RE.test(q)) return 'phone';
  if (USERNAME_RE.test(q)) return 'username';
  if (isIpAddress(q)) return 'ip';
  if (DOMAIN_RE.test(q)) return 'domain';
  if (CALCULATION_RE.test(q)) return 'calculation';
  if (COMPANY_RE.test(q)) return 'company';
  if (q.includes('?') || QUESTION_RE.test(q)) return 'factual';
  if (LOCATION_RE.test(q) || UK_POSTCODE_RE.test(q)) return 'location';
  if (looksLikePerson(q)) return 'person';
  return 'general';
}

/** Light alternate spelling. Returns null when the query does not change. */
export function spellingVariant(raw: string): string | null {
  const plain = stripQuotes(raw);
  const next = plain
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (/iey$/i.test(token) && token.length > 4) return `${token.slice(0, -3)}ey`;
      return token;
    })
    .join(' ');
  if (!next || next.toLowerCase() === plain.toLowerCase()) return null;
  return next;
}

function reorderedName(plain: string): string | null {
  const parts = plain.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return null;
  const last = parts[parts.length - 1];
  if (!last) return null;
  const next = [last, ...parts.slice(0, -1)].join(' ');
  return next.toLowerCase() === plain.toLowerCase() ? null : next;
}

/**
 * Progressive query plan.
 * Person/company: exact quoted name → normalized name → reordered name → spelling variant.
 * Other intents stay on the normalized query, plus a quoted form when it adds something.
 */
export function queryVariants(raw: string, intent: SearchIntent): string[] {
  const plain = stripQuotes(raw);
  const out: string[] = [];
  const push = (value: string) => {
    const next = value.trim();
    if (!next) return;
    if (out.some((existing) => existing.toLowerCase() === next.toLowerCase())) return;
    out.push(next);
  };

  if (intent === 'person' || intent === 'company') {
    push(`"${plain}"`);
    push(plain);
    const reordered = reorderedName(plain);
    if (reordered) push(reordered);
    const spelled = spellingVariant(plain);
    if (spelled) push(spelled);
  } else if (
    intent === 'email' ||
    intent === 'username' ||
    intent === 'phone' ||
    intent === 'domain' ||
    intent === 'ip'
  ) {
    push(`"${plain}"`);
    push(plain);
  } else {
    push(plain);
    if (plain.split(/\s+/).length > 1) push(`"${plain}"`);
  }
  return out.slice(0, 4);
}

export function buildSearchActions(query: string, intent: SearchIntent): SearchAction[] {
  const plain = stripQuotes(query);
  const actions: SearchAction[] = [];
  if (intent !== 'calculation' && intent !== 'plate') {
    actions.push({ id: 'web', label: 'Search web', query: plain });
  }
  const broader = intent === 'person' || intent === 'company' ? reorderedName(plain) : null;
  if (broader) actions.push({ id: 'broaden', label: 'Broaden search', query: broader });
  if (!/^["“]/.test(query.trim()) && plain.split(/\s+/).filter(Boolean).length > 1) {
    actions.push({ id: 'exact', label: 'Exact phrase', query: `"${plain}"` });
  }
  const spelled = spellingVariant(plain);
  if (spelled) actions.push({ id: 'spelling', label: 'Try alternate spelling', query: spelled });
  actions.push({ id: 'add', label: 'Add source URL' });
  return actions;
}
