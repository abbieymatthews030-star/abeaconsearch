const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Split text into lowercased word tokens (Unicode-aware). */
export function tokenize(input: string): string[] {
  return (input.toLowerCase().match(WORD_RE) ?? []).filter(Boolean);
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collapse runs of whitespace into single spaces and trim. */
export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Turn arbitrary text into a lowercase, hyphen-separated slug suitable for a
 * document id or tag value. Unicode letters/numbers are kept; everything else
 * becomes a single hyphen.
 */
export function slugify(input: string, maxLength = 80): string {
  return normalizeWhitespace(input)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}

/**
 * Build a plain-text excerpt of `body` centered on the earliest match of any
 * search term. Falls back to the beginning of the text when nothing matches.
 */
export function makeSnippet(body: string, terms: string[], radius = 160): string {
  const text = normalizeWhitespace(body);
  if (text.length === 0) return '';

  const lower = text.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    if (!term) continue;
    const at = lower.indexOf(term.toLowerCase());
    if (at !== -1 && (hit === -1 || at < hit)) hit = at;
  }

  if (hit === -1) {
    const head = text.slice(0, radius * 2);
    return head.length < text.length ? `${head.trimEnd()} …` : head;
  }

  const start = Math.max(0, hit - radius);
  const end = Math.min(text.length, hit + radius);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = `… ${snippet}`;
  if (end < text.length) snippet = `${snippet} …`;
  return snippet;
}

/**
 * HTML-escape `text`, then wrap every occurrence of a search term in `<mark>`.
 * The result is safe to inject as HTML: only the `<mark>` tags we add are live.
 */
export function highlight(text: string, terms: string[]): string {
  const escaped = escapeHtml(text);
  const usable = [
    ...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2)),
  ];
  if (usable.length === 0) return escaped;

  const pattern = usable
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');

  // Word-ish boundaries so "cat" does not highlight inside "category".
  return escaped.replace(
    new RegExp(`(?<![\\p{L}\\p{N}])(${pattern})(?![\\p{L}\\p{N}])`, 'giu'),
    '<mark>$1</mark>',
  );
}
