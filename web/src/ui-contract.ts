/**
 * Fields the web UI commits to knowing about. `npm run typecheck` fails when
 * `/api/query` or `/api/answer` grows a field that is not listed here.
 * `src/core/ui-contract.test.ts` then fails if App.tsx never mentions it.
 */
import type { AnswerResponse } from '@core/answer/types';
import type { UniversalQueryResponse } from '@core/query-router';
import type { DisplayHit, SearchEnvelope } from '@core/search/types';

type Expect<T extends true> = T;
type SameKeys<Listed extends string, Actual extends string> = [Exclude<Listed, Actual>] extends [
  never,
]
  ? [Exclude<Actual, Listed>] extends [never]
    ? true
    : false
  : false;

export const ENVELOPE_FIELDS = [
  'query',
  'intent',
  'outcome',
  'synthesis',
  'local',
  'results',
  'total',
  'tookMs',
  'attempted',
  'queriesTried',
  'diagnostics',
  'actions',
] as const;

export const QUERY_FIELDS = [...ENVELOPE_FIELDS, 'kind', 'primary'] as const;

export const DISPLAY_HIT_FIELDS = [
  'id',
  'title',
  'url',
  'snippet',
  'domain',
  'origin',
  'provider',
  'score',
  'tags',
  'updatedAt',
] as const;

export const ANSWER_FIELDS = [
  'query',
  'answer',
  'claims',
  'candidates',
  'sources',
  'confidence',
  'confidenceReason',
  'identityConfidence',
  'sourceQuality',
  'synthesizer',
  'disclaimer',
  'warnings',
  'searchGaps',
  'generatedAt',
  'tookMs',
  'cached',
] as const;

type _Envelope = Expect<SameKeys<(typeof ENVELOPE_FIELDS)[number], keyof SearchEnvelope>>;
type _Query = Expect<SameKeys<(typeof QUERY_FIELDS)[number], keyof UniversalQueryResponse>>;
type _Hit = Expect<SameKeys<(typeof DISPLAY_HIT_FIELDS)[number], keyof DisplayHit>>;
type _Answer = Expect<SameKeys<(typeof ANSWER_FIELDS)[number], keyof AnswerResponse>>;

void (0 as unknown as _Envelope | _Query | _Hit | _Answer);
