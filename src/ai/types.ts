/**
 * AI Module Types
 *
 * Type definitions for the front-end AI interpreter layer.
 */

/**
 * AI provider configuration stored in config.json
 */
export interface AIConfig {
  enabled: boolean;
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model?: string;
  temperature?: number;
  maxConversationMessages?: number;
  maxContextTokens?: number;       // Override auto-detected context window
  disableAutoCompact?: boolean;    // Opt out of auto-compaction
}

/**
 * Discriminated union of actions the AI interpreter can decide on.
 */
export type AIAction =
  | { type: 'spawn'; task: string; cwd?: string; permissionMode?: string }
  | { type: 'send_to_session'; text: string }
  | { type: 'reply_directly'; text: string }
  | { type: 'clarify'; question: string }
  | { type: 'passthrough' };

/**
 * Context passed to the interpreter to help it make decisions.
 */
export interface InterpretationContext {
  hasActiveSession: boolean;
  activeSessionId: string | null;
  activeSessionCwd: string | null;
  activeSessionTask: string | null;
  activeSessionStatus: string | null;
  recentOutput: string[];
  recentFolders: string[];
  hasPendingQuestion: boolean;
  sessionCount: number;
}

/**
 * Callbacks for observation tools to interact with terminal sessions.
 * Provided by the bot layer to the AI interpreter.
 */
export interface ObservationCallbacks {
  getTerminalOutput: (sessionId: string, lines?: number) => string;
  sendKeys: (sessionId: string, keys: string) => boolean;
  listSessions: () => Array<{
    id: string;
    status: string;
    task: string;
    cwd: string;
    ageMinutes: number;
    isActive: boolean;
  }>;
}

/**
 * Rule for auto-approving or denying tool use requests.
 */
export interface AutoApproveRule {
  name: string;
  match: {
    toolName?: string | string[];
    cwdPattern?: string;
    commandPattern?: string;
    filePattern?: string;
  };
  action: 'allow' | 'deny';
  reason?: string;
}

/**
 * Escalation severity levels for tool use operations.
 */
export type EscalationLevel = 'safe' | 'caution' | 'dangerous' | 'critical';

/**
 * Result of classifying a tool use for escalation.
 */
export interface EscalationResult {
  level: EscalationLevel;
  reason: string;
  patterns: string[];
}
