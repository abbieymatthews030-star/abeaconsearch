import {
  classifySourceType,
  isIndieDomain,
  isSeoMegaDomain,
  type SourceType,
} from './source-type.js';
import type { DisplayHit } from './types.js';

export interface RankableHit {
  hit: DisplayHit;
  plainTitle: string;
  domain?: string;
  /** ISO date when known (index updatedAt, archive capture year, etc.). */
  publishedAt?: string;
}

export interface RerankedHit extends RankableHit {
  hit: DisplayHit & {
    sourceType: SourceType;
    rankReasons: string[];
    score: number;
  };
}

function yearOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})/.exec(value);
  if (!match?.[1]) return undefined;
  const year = Number(match[1]);
  return Number.isFinite(year) && year >= 1990 && year <= 2100 ? year : undefined;
}

function ageBonus(publishedAt: string | undefined, nowYear: number): { bonus: number; reason?: string } {
  const year = yearOf(publishedAt);
  if (year == null) return { bonus: 0 };
  const age = nowYear - year;
  if (age >= 10) return { bonus: 0.85, reason: `older page (${year}) boosted` };
  if (age >= 5) return { bonus: 0.45, reason: `older page (${year}) boosted` };
  if (age >= 2) return { bonus: 0.15, reason: `established page (${year})` };
  return { bonus: 0 };
}

function typeBonus(type: SourceType): { bonus: number; reason: string } {
  switch (type) {
    case 'official':
      return { bonus: 1.6, reason: 'official / primary source' };
    case 'academic':
      return { bonus: 1.35, reason: 'academic / primary document' };
    case 'archive':
      return { bonus: 0.9, reason: 'archive capture' };
    case 'forum':
      return { bonus: 0.55, reason: 'forum / community discussion' };
    case 'blog':
      return { bonus: 0.35, reason: 'independent / blog source' };
    case 'news':
      return { bonus: 0.05, reason: 'news source' };
  }
}

/**
 * Re-score merged hits so indie domains, primary sources, archives and older
 * pages are not drowned by large SEO properties. Every adjustment is recorded
 * in `rankReasons` for the UI. Starts from the existing lexical score so
 * domain quality is not double-counted.
 */
export function rerankHits(
  items: RankableHit[],
  query: string,
  options: { now?: Date } = {},
): RerankedHit[] {
  const nowYear = (options.now ?? new Date()).getUTCFullYear();
  void query;
  const ranked: RerankedHit[] = items.map((item) => {
    const sourceType = classifySourceType({
      url: item.hit.url,
      domain: item.domain ?? item.hit.domain,
      provider: item.hit.provider,
    });
    const reasons: string[] = [];
    let score = item.hit.score;

    const typed = typeBonus(sourceType);
    score += typed.bonus;
    reasons.push(typed.reason);

    const domain = item.domain ?? item.hit.domain;
    if (isIndieDomain(domain)) {
      score += 0.55;
      reasons.push('small / independent domain');
    }
    if (isSeoMegaDomain(domain)) {
      score -= 1.15;
      reasons.push('large SEO site demoted');
    }

    const age = ageBonus(item.publishedAt ?? item.hit.updatedAt, nowYear);
    score += age.bonus;
    if (age.reason) reasons.push(age.reason);

    if (item.hit.origin === 'index') {
      score += 0.25;
      reasons.push('local index');
    }

    const nextHit: DisplayHit & { sourceType: SourceType; rankReasons: string[]; score: number } = {
      ...item.hit,
      sourceType,
      rankReasons: reasons,
      score: Number(score.toFixed(4)),
    };
    return {
      ...item,
      hit: nextHit,
    };
  });

  ranked.sort((a, b) => b.hit.score - a.hit.score);
  return ranked;
}
