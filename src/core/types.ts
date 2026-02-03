/**
 * Shared Types for ClaudeBridge
 *
 * Type definitions for Claude Code tool inputs and hook payloads.
 */

/**
 * Option for an AskUserQuestion question
 */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

/**
 * A single question in AskUserQuestion
 */
export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

/**
 * AskUserQuestion tool input structure from Claude Code
 */
export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];
}

/**
 * Pending AskUserQuestion state
 * Used to track questions waiting for user response
 */
export interface PendingAskUserQuestion {
  requestId: string;
  questions: AskUserQuestionItem[];
  sessionCwd: string;
  messageIds: number[];  // Telegram message IDs for cleanup
  selections: Map<number, Set<number>>;  // questionIndex -> selected option indices (-1 = custom text)
  customTexts?: Map<number, string>;  // questionIndex -> custom text (when selection is -1)
  createdAt: Date;
}

/**
 * Hook payload from Claude Code PreToolUse
 */
export interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/**
 * Hook payload from Claude Code PostToolUse
 */
export interface PostToolHookPayload extends HookPayload {
  tool_result?: string;
  error?: string;
}

/**
 * Hook response for PreToolUse
 */
export interface HookResponse {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

/**
 * Pending spawn request while waiting for folder selection
 */
export interface PendingSpawnRequest {
  task: string;
  permissionMode: 'default' | 'plan' | 'auto' | 'ask';
  messageId: number;
  createdAt: Date;
}
