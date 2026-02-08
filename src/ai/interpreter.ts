/**
 * AI Interpreter
 *
 * Core module that interprets user messages via generateText + tool calls
 * and returns a structured AIAction. Includes token-aware auto-compaction
 * of conversation memory.
 */

import { generateText, stepCountIs, type LanguageModel } from 'ai';
import type { AIConfig, AIAction, InterpretationContext, ObservationCallbacks } from './types.js';
import { createModel } from './provider.js';
import { ConversationMemory } from './conversation.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createAITools } from './tools.js';
import { computeTokenBudget } from './token-utils.js';
import { logger } from '../core/config.js';

const COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. Your task is to create a concise summary of the following conversation messages.

Preserve:
- Key decisions made and their reasoning
- Important context (project names, file paths, technologies)
- User preferences and instructions
- The current state of any ongoing work
- Any unresolved questions or pending items

Omit:
- Routine greetings and acknowledgements
- Redundant back-and-forth
- Verbose output that was already acted upon

Write the summary in a neutral, factual tone. Use bullet points for clarity. Keep it under 300 words.`;

export class Interpreter {
  private model: LanguageModel;
  private config: AIConfig;
  private callbacks: ObservationCallbacks;
  private memories = new Map<string, ConversationMemory>();

  constructor(config: AIConfig, callbacks: ObservationCallbacks) {
    this.config = config;
    this.model = createModel(config);
    this.callbacks = callbacks;
  }

  /**
   * Check if the interpreter is available and enabled.
   */
  isAvailable(): boolean {
    return this.config.enabled;
  }

  /**
   * Interpret a user message and return a structured action.
   * Falls back to passthrough on any error.
   */
  async interpret(
    chatId: string,
    userMessage: string,
    context: InterpretationContext
  ): Promise<AIAction> {
    try {
      const memory = this.getMemory(chatId);
      memory.add('user', userMessage);

      const systemPrompt = buildSystemPrompt(context);

      // Auto-compaction: check if memory needs compaction before calling AI
      if (!this.config.disableAutoCompact) {
        const modelName = this.config.model || (this.config.provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-20250514');
        const budget = computeTokenBudget(modelName, systemPrompt, this.config.maxContextTokens);

        if (memory.needsCompaction(budget)) {
          await this._performCompaction(memory, budget);
        }
      }

      const tools = createAITools(this.callbacks, context);

      const result = await generateText({
        model: this.model,
        system: systemPrompt,
        messages: memory.toAIMessages(),
        tools,
        toolChoice: 'required',
        stopWhen: stepCountIs(5),
        temperature: this.config.temperature ?? 0.3,
        maxOutputTokens: 1024,
        onStepFinish: ({ toolCalls }) => {
          logger.debug(`[Interpreter] Step: ${toolCalls.map(tc => tc.toolName).join(', ')}`);
        },
      });

      // The last step's tool call is the action (it had no execute, so the loop stopped).
      // Walk steps in reverse to find the final action tool call.
      let action: AIAction | null = null;
      const actionToolNames = new Set(['spawn_session', 'send_to_session', 'reply_directly', 'ask_clarification']);
      const steps = result.steps || [];
      let observationCount = 0;

      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        const tc = step.toolCalls?.[0];
        if (tc && actionToolNames.has(tc.toolName)) {
          const normalizedCall = {
            toolName: tc.toolName,
            args: (tc as any).input as Record<string, unknown> ?? {},
          };
          action = this.mapToolCallToAction(normalizedCall);
          observationCount = i; // all prior steps were observations
          break;
        }
      }

      if (!action) {
        logger.warn('[Interpreter] No action tool call found after agent loop, falling back to passthrough');
        return { type: 'passthrough' };
      }

      if (observationCount > 0) {
        logger.info(`[Interpreter] Agent used ${observationCount} observation step(s) before acting`);
      }

      // Record the AI's decision in conversation memory
      const summary = this.summarizeAction(action);
      memory.add('assistant', summary);

      logger.info(`[Interpreter] Action: ${action.type}`);
      logger.debug('[Interpreter] Full action:', JSON.stringify(action));

      return action;
    } catch (err) {
      logger.error('[Interpreter] Error interpreting message:', err);
      return { type: 'passthrough' };
    }
  }

  /**
   * Clear conversation memory for a specific chat.
   */
  clearMemory(chatId: string): void {
    this.memories.delete(chatId);
  }

  /**
   * Manually compact conversation memory for a chat.
   * Returns a status string with before/after token counts.
   */
  async compactMemory(chatId: string, context: InterpretationContext): Promise<string> {
    const memory = this.memories.get(chatId);
    if (!memory || memory.length === 0) {
      return 'Nothing to compact — conversation memory is empty.';
    }

    if (memory.length < 8) {
      return `Nothing to compact — only ${memory.length} messages in memory (need at least 8).`;
    }

    const systemPrompt = buildSystemPrompt(context);
    const modelName = this.config.model || (this.config.provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-20250514');
    const budget = computeTokenBudget(modelName, systemPrompt, this.config.maxContextTokens);

    const beforeTokens = memory.totalEstimatedTokens;
    const beforeCount = memory.length;

    // Force compaction even if under threshold
    await this._performCompaction(memory, budget, true);

    const afterTokens = memory.totalEstimatedTokens;
    const afterCount = memory.length;

    return (
      `Compacted conversation memory:\n` +
      `  Messages: ${beforeCount} → ${afterCount}\n` +
      `  Est. tokens: ~${beforeTokens} → ~${afterTokens}\n` +
      `  ${memory.hasSummary ? '(summary stored)' : ''}`
    );
  }

  /**
   * Get memory stats for a chat, for display purposes.
   */
  getMemoryStats(chatId: string): { messageCount: number; estimatedTokens: number; hasSummary: boolean } {
    const memory = this.memories.get(chatId);
    if (!memory) {
      return { messageCount: 0, estimatedTokens: 0, hasSummary: false };
    }
    return {
      messageCount: memory.length,
      estimatedTokens: memory.totalEstimatedTokens,
      hasSummary: memory.hasSummary,
    };
  }

  /**
   * Get or create conversation memory for a chat.
   */
  private getMemory(chatId: string): ConversationMemory {
    let memory = this.memories.get(chatId);
    if (!memory) {
      memory = new ConversationMemory(this.config.maxConversationMessages);
      this.memories.set(chatId, memory);
    }
    return memory;
  }

  /**
   * Perform compaction on a conversation memory.
   * Summarizes old messages via AI and stores the result.
   */
  private async _performCompaction(
    memory: ConversationMemory,
    budget: number,
    force = false,
  ): Promise<void> {
    const toCompact = force
      ? memory.getMessagesToCompact(budget) ?? this._forceGetMessages(memory)
      : memory.getMessagesToCompact(budget);

    if (!toCompact || toCompact.count === 0) return;

    logger.info(`[Interpreter] Auto-compacting conversation memory... (${toCompact.count} messages)`);

    // Format messages for summarization
    const formatted = toCompact.messages.map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${m.role}]: ${content}`;
    }).join('\n\n');

    try {
      const result = await generateText({
        model: this.model,
        system: COMPACT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: formatted }],
        temperature: 0.2,
        maxOutputTokens: 512,
      });

      const summaryText = result.text?.trim();
      if (summaryText) {
        memory.applyCompaction(summaryText, toCompact.count);
        logger.info(`[Interpreter] Compaction complete — ${toCompact.count} messages summarized`);
      } else {
        // AI returned empty response, use fallback
        this._applyFallbackCompaction(memory, toCompact);
      }
    } catch (err) {
      logger.warn('[Interpreter] Compaction AI call failed, using fallback:', err);
      this._applyFallbackCompaction(memory, toCompact);
    }
  }

  /**
   * When force-compacting but getMessagesToCompact returns null (e.g. under threshold),
   * create a minimal compaction target from the oldest eligible messages.
   */
  private _forceGetMessages(memory: ConversationMemory): { messages: import('ai').ModelMessage[]; count: number } | null {
    // Force compact up to half of non-recent messages
    const allMessages = memory.toAIMessages().filter((_, i) => i < memory.length); // exclude summary
    const eligible = memory.length - 6;
    if (eligible < 4) return null;
    const count = Math.min(Math.ceil(eligible / 2), eligible);
    // We can only access messages via toAIMessages, but we need the raw messages
    // Since toAIMessages prepends summary, we need to account for that offset
    const offset = memory.hasSummary ? 1 : 0;
    const messages = memory.toAIMessages().slice(offset, offset + count);
    return { messages, count };
  }

  /**
   * Fallback compaction: create a descriptive note from message prefixes
   * when AI summarization fails.
   */
  private _applyFallbackCompaction(
    memory: ConversationMemory,
    toCompact: { messages: import('ai').ModelMessage[]; count: number },
  ): void {
    const previews = toCompact.messages.slice(0, 3).map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const preview = content.slice(0, 100);
      return `- [${m.role}]: ${preview}${content.length > 100 ? '...' : ''}`;
    });

    const fallback = `[Conversation summary — ${toCompact.count} earlier messages]\n${previews.join('\n')}`;
    memory.applyCompaction(fallback, toCompact.count);
    logger.info(`[Interpreter] Fallback compaction applied — ${toCompact.count} messages`);
  }

  /**
   * Map a tool call result to an AIAction.
   */
  private mapToolCallToAction(toolCall: { toolName: string; args: Record<string, unknown> }): AIAction {
    switch (toolCall.toolName) {
      case 'spawn_session':
        return {
          type: 'spawn',
          task: toolCall.args.task as string,
          cwd: toolCall.args.cwd as string | undefined,
          permissionMode: toolCall.args.permissionMode as string | undefined,
        };

      case 'send_to_session':
        return {
          type: 'send_to_session',
          text: toolCall.args.text as string,
        };

      case 'reply_directly':
        return {
          type: 'reply_directly',
          text: toolCall.args.text as string,
        };

      case 'ask_clarification':
        return {
          type: 'clarify',
          question: toolCall.args.question as string,
        };

      default:
        logger.warn(`[Interpreter] Unknown tool call: ${toolCall.toolName}`);
        return { type: 'passthrough' };
    }
  }

  /**
   * Create a brief summary of an action for conversation history.
   */
  private summarizeAction(action: AIAction): string {
    switch (action.type) {
      case 'spawn':
        return `[Spawning session: "${action.task.slice(0, 80)}"]`;
      case 'send_to_session':
        return `[Forwarded to session: "${action.text.slice(0, 80)}"]`;
      case 'reply_directly':
        return action.text;
      case 'clarify':
        return action.question;
      case 'passthrough':
        return '[Passed through to legacy handler]';
    }
  }
}
