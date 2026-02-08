/**
 * AI Provider
 *
 * Creates a Vercel AI SDK LanguageModel from the configured provider.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { AIConfig } from './types.js';

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
};

/**
 * Create a LanguageModel instance from the AI config.
 */
export function createModel(config: AIConfig): LanguageModel {
  const modelName = config.model || DEFAULT_MODELS[config.provider] || 'gpt-4o';

  switch (config.provider) {
    case 'openai': {
      const openai = createOpenAI({ apiKey: config.apiKey });
      return openai(modelName);
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: config.apiKey });
      return anthropic(modelName);
    }
    default:
      throw new Error(`Unknown AI provider: ${config.provider}`);
  }
}
