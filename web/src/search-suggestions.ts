export interface SearchSuggestion {
  value: string;
  source: 'recent' | 'index';
}

const MAX_SUGGESTIONS = 8;
const MAX_RECENT_SUGGESTIONS = 4;

export function buildSearchSuggestions(
  query: string,
  indexedSuggestions: readonly string[],
  recentQueries: readonly string[],
): SearchSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length < 2) return [];

  const suggestions: SearchSuggestion[] = [];
  const seen = new Set<string>();
  const add = (value: string, source: SearchSuggestion['source']): boolean => {
    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();
    if (
      !trimmed ||
      normalized === normalizedQuery ||
      seen.has(normalized) ||
      suggestions.length >= MAX_SUGGESTIONS
    ) {
      return false;
    }
    seen.add(normalized);
    suggestions.push({ value: trimmed, source });
    return true;
  };

  let recentCount = 0;
  for (const recent of recentQueries) {
    if (!recent.trim().toLowerCase().startsWith(normalizedQuery)) continue;
    if (add(recent, 'recent')) recentCount += 1;
    if (recentCount >= MAX_RECENT_SUGGESTIONS || suggestions.length >= MAX_SUGGESTIONS) break;
  }

  for (const indexed of indexedSuggestions) {
    add(indexed, 'index');
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }

  return suggestions;
}
