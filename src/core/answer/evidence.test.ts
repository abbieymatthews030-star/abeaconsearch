import { describe, expect, it } from 'vitest';
import {
  classifyEntityMatch,
  clusterCandidates,
  looksLikeIdentityQuery,
  scoreContentQuality,
  scoreRelevance,
  stripLeadingNavList,
} from './evidence.js';

// A realistic concatenation of YouTube's static footer/nav chrome — no
// sentence punctuation, run-on CamelCase joins, pure boilerplate vocabulary.
const YOUTUBE_FOOTER =
  'AboutPressCopyrightContact usCreatorsAdvertiseDevelopersTermsPrivacyPolicy & SafetyHow YouTube worksTest new features© 2026 Google LLC';

const REAL_PROSE =
  'Abbiey Matthews is a software engineer based in Melbourne, Australia. She previously worked at a fintech startup before founding her own consultancy in 2022, focusing on backend infrastructure and search systems.';

describe('scoreContentQuality', () => {
  it('flags run-on navigation/footer boilerplate as unusable', () => {
    const { score, isBoilerplate } = scoreContentQuality(YOUTUBE_FOOTER);
    expect(isBoilerplate).toBe(true);
    expect(score).toBeLessThan(0.4);
  });

  it('retains a real, substantive description as usable', () => {
    const { score, isBoilerplate } = scoreContentQuality(REAL_PROSE);
    expect(isBoilerplate).toBe(false);
    expect(score).toBeGreaterThan(0.4);
  });

  it('flags very short text as unusable rather than scoring it highly by accident', () => {
    expect(scoreContentQuality('Hi.').isBoilerplate).toBe(true);
  });

  it('flags unrendered template placeholders as boilerplate, not real content', () => {
    // A real bug found via live testing: a client-rendered page whose
    // template never got filled in server-side (common for SPA review
    // widgets etc.) looks structurally like normal text otherwise.
    const templateJunk =
      'Portfolio Reviews Portfolio is currently locked. {{ reviewsTotal }}{{ options.labels.singularReviewCountLabel }} {{ reviewsTotal }}{{ options.labels.pluralReviewCountLabel }}';
    expect(scoreContentQuality(templateJunk).isBoilerplate).toBe(true);
  });
});

describe('looksLikeIdentityQuery', () => {
  it('recognises a two-to-five Title Case word query as a person/entity search', () => {
    expect(looksLikeIdentityQuery('Maiz Gustavo')).toBe(true);
    expect(looksLikeIdentityQuery('Gustavo Angel Maddonni')).toBe(true);
    expect(looksLikeIdentityQuery('"Abbiey Matthews"')).toBe(true);
  });

  it('does not treat an ordinary lowercase query as identity-shaped', () => {
    expect(looksLikeIdentityQuery('react hooks')).toBe(false);
    expect(looksLikeIdentityQuery('where do penguins live')).toBe(false);
  });

  it('recognises a lowercase-typed name — real search boxes are not Title Case', () => {
    // Regression: the first version of this heuristic required every word to
    // start with a capital letter, which only matched "Maiz Gustavo" and
    // never the "maiz gustavo" a real user actually types.
    expect(looksLikeIdentityQuery('maiz gustavo')).toBe(true);
    expect(looksLikeIdentityQuery('abbiey matthews')).toBe(true);
  });
});

describe('classifyEntityMatch', () => {
  it('is an exact match when the whole name phrase appears in the title', () => {
    const result = classifyEntityMatch('Maiz Gustavo', 'Maiz Gustavo - Carpentry Australia', 'Local carpentry services.');
    expect(result.type).toBe('exact');
    expect(result.candidateName).toBe('maiz gustavo');
  });

  it('classifies a different specific named entity as "different", not a weak match', () => {
    const result = classifyEntityMatch(
      'Maiz Gustavo',
      'Gustavo Angel Maddonni',
      'Gustavo Angel Maddonni is an agronomist researching maize crop physiology and yield.',
    );
    expect(result.type).toBe('different');
  });

  it('does not grant identity credit for query tokens appearing separately on an unrelated page', () => {
    const result = classifyEntityMatch(
      'Maiz Gustavo',
      'Annual Report 2024',
      'Gustavo reviewed the quarterly figures. Later the report covers maize export tariffs in a separate section.',
    );
    expect(result.type).not.toBe('exact');
  });

  it('does not grant identity credit for a same-first-name match on a topical page', () => {
    const result = classifyEntityMatch(
      'Maiz Gustavo',
      "Gustavo's Maize Research Blog",
      'This blog covers maize agronomy research from around the world.',
    );
    expect(result.type).not.toBe('exact');
  });

  it('is neutral ("n/a") for an ordinary non-identity query', () => {
    expect(classifyEntityMatch('react hooks', 'React Hooks Deep Dive', 'useEffect and useState...').type).toBe('n/a');
  });
});

describe('clusterCandidates', () => {
  it('keeps distinct entities in separate clusters by default (never merges without evidence)', () => {
    const sources = [
      { id: 1, title: 'Maiz Gustavo - Carpentry Australia', entityMatchType: 'exact' as const, candidateName: 'maiz gustavo' },
      { id: 2, title: 'Gustavo Angel Maddonni', entityMatchType: 'different' as const, candidateName: 'gustavo angel maddonni' },
      { id: 3, title: 'Los Guardianes del Maiz', entityMatchType: 'different' as const, candidateName: 'los guardianes del maiz' },
    ];
    const clusters = clusterCandidates(sources);
    expect(clusters).toHaveLength(3);
    expect(clusters.every((c) => c.sourceIds.length === 1)).toBe(true);
  });

  it('clusters multiple sources that share an identical normalized candidate name', () => {
    const sources = [
      { id: 1, title: 'Maiz Gustavo', entityMatchType: 'exact' as const, candidateName: 'maiz gustavo' },
      { id: 2, title: 'Maiz Gustavo Profile', entityMatchType: 'exact' as const, candidateName: 'maiz gustavo' },
    ];
    const clusters = clusterCandidates(sources);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sourceIds.sort()).toEqual([1, 2]);
  });

  it('sorts clusters with an exact match first', () => {
    const sources = [
      { id: 1, title: 'Topical Thing', entityMatchType: 'topical' as const, candidateName: 'topical thing' },
      { id: 2, title: 'Maiz Gustavo', entityMatchType: 'exact' as const, candidateName: 'maiz gustavo' },
    ];
    const clusters = clusterCandidates(sources);
    expect(clusters[0]?.matchType).toBe('exact');
  });
});

describe('stripLeadingNavList', () => {
  it('strips a glued-on destination/nav list that precedes the real content', () => {
    const text =
      'Home Spain Sydney San Francisco Paris Las Vegas Maui Paris facts: Paris is the capital of France, the largest country of Europe.';
    const stripped = stripLeadingNavList(text);
    expect(stripped).not.toContain('Sydney');
    expect(stripped.toLowerCase()).toContain('paris is the capital of france');
  });

  it('leaves a real sentence that simply opens with a short proper-noun subject alone', () => {
    expect(stripLeadingNavList('Abbiey Matthews is a software engineer.')).toBe(
      'Abbiey Matthews is a software engineer.',
    );
    expect(stripLeadingNavList('The New York Times reported the news today.')).toBe(
      'The New York Times reported the news today.',
    );
  });
});

describe('scoreRelevance', () => {
  it('scores a title/body match for the query terms highly', () => {
    expect(scoreRelevance('penguins antarctica', 'Penguins of Antarctica', 'Penguins live in Antarctica.')).toBeGreaterThan(0.5);
  });

  it('scores completely unrelated content near zero', () => {
    expect(scoreRelevance('penguins antarctica', 'Tax Law Update', 'New invoice regulations for 2026.')).toBeLessThan(0.2);
  });
});
