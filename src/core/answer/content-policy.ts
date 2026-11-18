/**
 * Narrow content policy for answer synthesis.
 *
 * Every query is answered unless it targets one of the denied categories below.
 * Morally grey, illegal-in-some-jurisdictions, or ethically debatable topics
 * are intentionally allowed — no moral judgment or soft refusal.
 */

export type DeniedCategory =
  | 'bestiality'
  | 'sexual_violence_against_women'
  | 'physical_violence_against_women';

export type ContentDecision =
  | { allowed: true }
  | { allowed: false; category: DeniedCategory; reason: string };

const WOMEN =
  String.raw`(?:women|woman|girls?|females?|wife|wives|girlfriend|mother|sister|daughter)`;

/** Bestiality / zoophilia (sexual content involving animals). */
const BESTIALITY_PATTERNS: RegExp[] = [
  /\bbestiality\b/i,
  /\bzoophil(?:ia|e|ic|ous)?\b/i,
  /\b(?:sex(?:ual(?:ly)?)?|rape|porn(?:ography)?|fuck(?:ing)?)\b[^.\n]{0,40}\b(?:animals?|dogs?|horses?|cats?|livestock|pets?|cattle|sheep|goats?)\b/i,
  /\b(?:animals?|dogs?|horses?|cats?|livestock|pets?|cattle|sheep|goats?)\b[^.\n]{0,40}\b(?:sex(?:ual(?:ly)?)?|rape|porn(?:ography)?|fuck(?:ing)?|intercourse)\b/i,
];

/** Sexual violence specifically targeting women / girls. */
const SEXUAL_VAW_PATTERNS: RegExp[] = [
  new RegExp(
    String.raw`\b(?:rape|raping|rapes|gang[\s-]?rape|sexual(?:ly)?\s+assault(?:ing|ed)?|molest(?:ing|ation)?)\b[^.\n]{0,48}\b${WOMEN}\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b${WOMEN}\b[^.\n]{0,48}\b(?:rape|raping|rapes|gang[\s-]?rape|sexual(?:ly)?\s+assault(?:ing|ed)?|molest(?:ing|ation)?)\b`,
    'i',
  ),
  /\b(?:force|forcing)\b[^.\n]{0,32}\b(?:sex|intercourse)\b[^.\n]{0,32}\b(?:women|woman|girls?|wife|girlfriend)\b/i,
];

/** Physical violence specifically targeting women / girls. */
const PHYSICAL_VAW_PATTERNS: RegExp[] = [
  /\bviolence against women\b/i,
  /\b(?:domestic|physical)\s+violence\b[^.\n]{0,32}\b(?:women|woman|girls?|wife|wives|girlfriend)\b/i,
  new RegExp(
    String.raw`\b(?:beating|assaulting|strangling|stabbing|murdering|killing|hitting|abusing|torturing)\b[^.\n]{0,40}\b${WOMEN}\b`,
    'i',
  ),
  new RegExp(
    String.raw`\bhow\s+to\s+(?:hurt|harm|beat|kill|abuse|assault|strangle|stab)\b[^.\n]{0,40}\b${WOMEN}\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b${WOMEN}\b[^.\n]{0,40}\b(?:beating|assault|strangling|stabbing|murder|killing|torture)\b`,
    'i',
  ),
];

const DENY_REASONS: Record<DeniedCategory, string> = {
  bestiality: 'Queries about bestiality or sexual content involving animals are not answered.',
  sexual_violence_against_women:
    'Queries about sexual violence against women are not answered.',
  physical_violence_against_women:
    'Queries about physical violence against women are not answered.',
};

/**
 * Decide whether a query may receive an answer. Only the three denied
 * categories return `{ allowed: false }`; everything else is allowed.
 */
export function evaluateQueryContent(raw: string): ContentDecision {
  const query = raw.trim();
  if (!query) return { allowed: true };

  for (const re of BESTIALITY_PATTERNS) {
    if (re.test(query)) {
      return {
        allowed: false,
        category: 'bestiality',
        reason: DENY_REASONS.bestiality,
      };
    }
  }
  for (const re of SEXUAL_VAW_PATTERNS) {
    if (re.test(query)) {
      return {
        allowed: false,
        category: 'sexual_violence_against_women',
        reason: DENY_REASONS.sexual_violence_against_women,
      };
    }
  }
  for (const re of PHYSICAL_VAW_PATTERNS) {
    if (re.test(query)) {
      return {
        allowed: false,
        category: 'physical_violence_against_women',
        reason: DENY_REASONS.physical_violence_against_women,
      };
    }
  }
  return { allowed: true };
}

/** User-facing denial copy when a query hits the content policy. */
export function deniedAnswerText(category: DeniedCategory): string {
  return (
    'This query cannot be answered. Beacon does not return results for ' +
    (category === 'bestiality'
      ? 'bestiality'
      : 'sexual or physical violence against women') +
    '.'
  );
}

/**
 * Detect common LLM soft-refusal / policy-lecture phrasing so the answer
 * service can retry or fall back instead of surfacing a refusal as the answer.
 */
export function looksLikeModelRefusal(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return (
    /\b(?:i(?:'m| am) (?:sorry|unable|not (?:able|allowed))|i (?:can'?t|cannot|won'?t|must refuse|have to refuse))\b/i.test(
      t,
    ) ||
    /\b(?:as an ai|against (?:my|our|the) (?:guidelines|policies|content policy)|i(?:'m| am) not able to (?:help|assist|provide|answer))\b/i.test(
      t,
    ) ||
    /\b(?:i must decline|i will not (?:provide|assist|help|answer)|cannot (?:assist|help) with that)\b/i.test(
      t,
    )
  );
}
