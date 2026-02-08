/**
 * Conversation Memory
 *
 * Per-chat conversation memory with token tracking and compaction support.
 * Instead of silently dropping old messages, supports summarizing them
 * into a compact summary slot.
 */

import type { ModelMessage } from 'ai';
import { estimateTokens, estimateMessagesTokens, AUTO_COMPACT_THRESHOLD, COMPACT_TARGET_RATIO } from './token-utils.js';

const DEFAULT_MAX_MESSAGES = 50;

/** Minimum messages that must exist before compaction is considered. */
const MIN_MESSAGES_FOR_COMPACTION = 10;

/** Number of recent messages to always keep (never compact). */
const KEEP_RECENT_MESSAGES = 6;

/** Minimum number of messages to compact in one pass. */
const MIN_COMPACT_COUNT = 4;

export class ConversationMemory {
  private messages: ModelMessage[] = [];
  private maxMessages: number;
  private summary: string | null = null;
  private _estimatedTokens = 0;

  constructor(maxMessages?: number) {
    this.maxMessages = maxMessages || DEFAULT_MAX_MESSAGES;
  }

  add(role: 'user' | 'assistant', content: string): void {
    this.messages.push({ role, content });
    this._estimatedTokens += estimateTokens(content) + 4; // +4 per-message overhead

    // Hard safety cap: if messages exceed 2x max, trim oldest
    // (prevents unbounded growth if compaction fails)
    const hardCap = this.maxMessages * 2;
    if (this.messages.length > hardCap) {
      const excess = this.messages.length - this.maxMessages;
      const removed = this.messages.splice(0, excess);
      this._estimatedTokens -= estimateMessagesTokens(removed);
    }
  }

  /**
   * Build messages array for AI consumption.
   * If a summary exists, prepend it as a user message before current messages.
   */
  toAIMessages(): ModelMessage[] {
    const result: ModelMessage[] = [];

    if (this.summary) {
      result.push({
        role: 'user',
        content: `[Previous conversation summary]\n${this.summary}`,
      });
    }

    result.push(...this.messages);
    return result;
  }

  clear(): void {
    this.messages = [];
    this.summary = null;
    this._estimatedTokens = 0;
  }

  get length(): number {
    return this.messages.length;
  }

  /** Estimated total tokens including summary. */
  get totalEstimatedTokens(): number {
    let total = this._estimatedTokens;
    if (this.summary) {
      total += estimateTokens(this.summary) + 4;
    }
    return total;
  }

  get hasSummary(): boolean {
    return this.summary !== null;
  }

  /**
   * Check if conversation needs compaction given a token budget.
   * Returns true when tokens exceed threshold AND enough messages exist.
   */
  needsCompaction(budget: number): boolean {
    if (this.messages.length < MIN_MESSAGES_FOR_COMPACTION) return false;
    return this.totalEstimatedTokens > budget * AUTO_COMPACT_THRESHOLD;
  }

  /**
   * Determine which messages should be compacted.
   * Walks from oldest, accumulating tokens until enough would be freed
   * to reach the target ratio. Never touches the last KEEP_RECENT_MESSAGES.
   *
   * Returns the messages to compact, or null if not enough eligible messages.
   */
  getMessagesToCompact(budget: number): { messages: ModelMessage[]; count: number } | null {
    const compactableCount = this.messages.length - KEEP_RECENT_MESSAGES;
    if (compactableCount < MIN_COMPACT_COUNT) return null;

    const targetTokens = budget * COMPACT_TARGET_RATIO;
    const tokensToFree = this.totalEstimatedTokens - targetTokens;
    if (tokensToFree <= 0) return null;

    let accumulated = 0;
    let count = 0;

    for (let i = 0; i < compactableCount; i++) {
      const msg = this.messages[i];
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      accumulated += estimateTokens(content) + 4;
      count++;

      if (accumulated >= tokensToFree) break;
    }

    if (count < MIN_COMPACT_COUNT) count = Math.min(MIN_COMPACT_COUNT, compactableCount);

    return {
      messages: this.messages.slice(0, count),
      count,
    };
  }

  /**
   * Apply compaction: remove first `count` messages and store summary.
   * If a summary already exists, appends with separator.
   */
  applyCompaction(summaryText: string, count: number): void {
    const removed = this.messages.splice(0, count);
    this._estimatedTokens -= estimateMessagesTokens(removed);

    if (this.summary) {
      this.summary += '\n---\n' + summaryText;
    } else {
      this.summary = summaryText;
    }
  }
}
