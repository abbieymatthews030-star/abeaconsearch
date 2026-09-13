import { classifyAuPlate } from './au-format.js';
import { classifyPlate } from './format.js';
import type { PlateCountry } from './types.js';

/**
 * Guess which country's rules a normalized plate matches. Pass `hint` to
 * skip detection and force a country (used when the caller already knows,
 * e.g. an explicit `country` request parameter).
 *
 * The UK's structured eras (current/prefix/suffix/NI/diplomatic) are tried
 * first — they're tightly constrained and don't collide with Australian
 * shapes. The UK's catch-all `dateless` bucket (any short letters+digits or
 * digits+letters combo, for pre-1963 and cherished marks) is deliberately
 * tried *after* the Australian shapes: a 6-character "ABC123"-style code is
 * far more likely to be a standard-issue Australian plate than a rare UK
 * cherished mark, and the two are structurally indistinguishable.
 */
export function detectCountry(normalized: string, hint?: 'GB' | 'AU'): PlateCountry {
  if (hint) return hint;
  const gb = classifyPlate(normalized);
  if (gb.valid && gb.format !== 'dateless') return 'GB';
  if (classifyAuPlate(normalized).valid) return 'AU';
  if (gb.valid) return 'GB';
  return 'unknown';
}
