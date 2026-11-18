/** Shared query-shape patterns used by classifyQuery and detectIntent. */

export const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/i;

// Whole string is digits/operators/parens only, with at least one operator —
// a bare number like "2024" is deliberately left as a normal search term.
export const CALCULATION_RE = /^[-+]?[\d\s().]+(?:[-+*/^%][-+]?[\d\s().]+)+$/;

export const PLATE_RE = /^plate\s+\S+/i;
