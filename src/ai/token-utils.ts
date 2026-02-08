/**
 * Token Utilities
 *
 * Token estimation, model context window lookup, and budget computation
 * for conversation memory compaction.
 */

import type { ModelMessage } from 'ai';

/** Approximate tokens per message overhead (role, formatting). */
const PER_MESSAGE_OVERHEAD = 4;

/** Reserved tokens for tool definitions in the prompt. */
const TOOL_DEFINITIONS_BUDGET = 700;

/** Reserved tokens for model output. */
const OUTPUT_BUDGET = 1024;

/** Safety margin as a fraction of total context window. */
const SAFETY_MARGIN = 0.10;

/** When estimated tokens exceed this fraction of budget, trigger compaction. */
export const AUTO_COMPACT_THRESHOLD = 0.75;

/** After compaction, aim to reduce tokens to this fraction of budget. */
export const COMPACT_TARGET_RATIO = 0.50;

/**
 * Estimate token count for a text string.
 * Uses ~4 characters per token heuristic.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens for an array of messages.
 * Includes per-message overhead for role/formatting.
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    total += estimateTokens(content) + PER_MESSAGE_OVERHEAD;
  }
  return total;
}

/** Known context window sizes by model name prefix. */
const CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'o1': 200_000,
  'o3': 200_000,
  'claude-opus': 200_000,
  'claude-sonnet': 200_000,
  'claude-haiku': 200_000,
  'claude-3': 200_000,
  'claude-4': 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Look up the context window size for a model.
 * Matches by longest prefix. Defaults to 128K.
 */
export function getContextWindowSize(model: string): number {
  // Try exact match first
  if (CONTEXT_WINDOWS[model]) return CONTEXT_WINDOWS[model];

  // Try prefix match (longest prefix wins)
  let bestMatch = '';
  for (const prefix of Object.keys(CONTEXT_WINDOWS)) {
    if (model.startsWith(prefix) && prefix.length > bestMatch.length) {
      bestMatch = prefix;
    }
  }

  return bestMatch ? CONTEXT_WINDOWS[bestMatch] : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Compute the token budget available for conversation history.
 *
 * budget = contextWindow - systemPrompt - tools - output - safetyMargin
 */
export function computeTokenBudget(
  modelName: string,
  systemPrompt: string,
  overrideContextWindow?: number,
): number {
  const contextWindow = overrideContextWindow || getContextWindowSize(modelName);
  const systemTokens = estimateTokens(systemPrompt);
  const reserved = systemTokens + TOOL_DEFINITIONS_BUDGET + OUTPUT_BUDGET;
  const safetyMargin = Math.floor(contextWindow * SAFETY_MARGIN);
  return Math.max(contextWindow - reserved - safetyMargin, 1024);
}
