import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { AnswerService, type EngineLike } from './answer-service.js';

export { AnswerService, AnswerBusyError } from './answer-service.js';
export type { AnswerServiceDeps, AnswerOptions } from './answer-service.js';
export {
  evaluateQueryContent,
  deniedAnswerText,
  looksLikeModelRefusal,
} from './content-policy.js';
export type { ContentDecision } from './content-policy.js';
export type * from './types.js';

export interface CreateAnswerServiceOptions {
  engine: EngineLike;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/**
 * Build the answer service from runtime config, or return `null` when answer
 * synthesis is disabled (`BEACON_ANSWER_ENABLED=false`). With no LLM or
 * web-search credentials configured it still works — answers are then a
 * deterministic weave of local-index extracts.
 */
export function createAnswerService(
  config: Config,
  options: CreateAnswerServiceOptions,
): AnswerService | null {
  if (!config.answer.enabled) return null;
  return new AnswerService({
    engine: options.engine,
    config: config.answer,
    userAgent: config.crawlUserAgent,
    fetchImpl: options.fetchImpl,
    logger: options.logger,
  });
}
