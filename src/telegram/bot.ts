/**
 * Telegram Bot Module
 *
 * Handles Telegram interactions using grammY.
 * Sends approval requests and receives user decisions.
 * Manages PTY sessions for Claude Code.
 */

import { Bot, InlineKeyboard, Context, InputFile } from 'grammy';
import { SessionManager, Session, PermissionMode } from '../core/session-manager.js';
import { ParsedPrompt } from '../core/output-parser.js';
import {
  AskUserQuestionItem,
  PendingAskUserQuestion,
  PendingSpawnRequest,
} from '../core/types.js';
import {
  getRecentFolders,
  addRecentFolder,
  removeRecentFolder,
  clearRecentFolders,
  loadConfig,
  saveConfig,
  logger,
} from '../core/config.js';
import type { Interpreter } from '../ai/interpreter.js';
import type { AIAction, ObservationCallbacks } from '../ai/types.js';

import sharp from 'sharp';

// Callback for when chat ID changes (for persistence)
type ChatIdCallback = (chatId: string) => void;

// Callback for getting recent console output
type GetConsoleOutputCallback = () => string[];

// Get default working directory
type GetDefaultCwdCallback = () => string;

// ANSI escape code regex for stripping colors and control sequences
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07?)/g;

/**
 * Strip ANSI escape codes and clean terminal output for display
 */
function cleanTerminalOutput(text: string): string {
  return text
    .replace(ANSI_REGEX, '') // Remove ANSI codes
    .replace(/\r\n/g, '\n')  // Normalize line endings
    .replace(/\r/g, '')      // Remove carriage returns
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

/**
 * Sanitize terminal output for SVG conversion (remove invalid XML chars)
 */
function sanitizeForSvg(text: string): string {
  // Remove ALL control characters except newline (0x0A) and space (0x20+)
  // Also remove DEL (0x7F) and anything above 0xFFFF that might cause issues
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '') // Remove control chars except \n
    .replace(/[^\x0A\x20-\x7E\xA0-\uFFFF]/g, ''); // Keep only printable + newline
}

/**
 * Shorten a path by replacing home directory with ~
 */
function shortenPath(fullPath: string): string {
  const home = process.env.HOME || '';
  if (home && fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

/**
 * Expand ~ to home directory
 */
function expandPath(shortPath: string): string {
  const home = process.env.HOME || '';
  if (shortPath.startsWith('~')) {
    return home + shortPath.slice(1);
  }
  return shortPath;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  timestamp: Date;
  resolve: (decision: 'allow' | 'deny') => void;
}

export interface RecordedAction {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  sessionId: string;
  timestamp: Date;
  success: boolean;
  error?: string;
}

export class TelegramBot {
  private bot: Bot;
  private chatId: string | null = null;
  private allowedChatIds: string[];
  private pendingApprovals = new Map<string, ApprovalRequest>();
  private onChatIdChange: ChatIdCallback | null = null;
  private getConsoleOutput: GetConsoleOutputCallback | null = null;
  private getDefaultCwd: GetDefaultCwdCallback | null = null;

  // Auto-approve mode state
  private autoApproveMode = false;
  private autoApproveStartTime: Date | null = null;
  private autoApproveCount = 0;

  // Session management
  private sessionManager: SessionManager;
  private activeSessionId: string | null = null;

  // Action tracking (from PostToolUse hooks)
  private recordedActions: RecordedAction[] = [];
  private readonly MAX_ACTIONS = 100;

  // Pending AskUserQuestion requests (from PreToolUse hook)
  private pendingQuestions = new Map<string, PendingAskUserQuestion>();

  // Track pending custom input (when user clicks "Type custom..." on a question)
  private pendingCustomInput: { requestId: string; questionIndex: number } | null = null;

  // Pending spawn request (awaiting folder selection)
  private pendingSpawn: PendingSpawnRequest | null = null;

  // Track if we're waiting for custom folder path input
  private pendingSpawnCustomPath = false;

  // AI interpreter (optional)
  private interpreter: Interpreter | null = null;

  constructor(
    token: string,
    onChatIdChange?: ChatIdCallback,
    getConsoleOutput?: GetConsoleOutputCallback,
    getDefaultCwd?: GetDefaultCwdCallback,
    interpreter?: Interpreter | null
  ) {
    this.bot = new Bot(token);
    this.onChatIdChange = onChatIdChange || null;
    this.getConsoleOutput = getConsoleOutput || null;
    this.getDefaultCwd = getDefaultCwd || null;
    this.interpreter = interpreter || null;
    this.sessionManager = new SessionManager();

    // Load allowed chat IDs from config
    const config = loadConfig();
    this.allowedChatIds = config.allowedChatIds || [];

    this.setupHandlers();
    this.setupSessionHandlers();
  }

  /**
   * Check if a chat/user is authorized to use this bot.
   * If no allowlist is configured, the first user to /start is accepted.
   * Once a chat ID is registered (via /start), only that chat ID and
   * any IDs in the allowlist are permitted.
   */
  private isAuthorized(ctx: Context): boolean {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return false;

    // If an allowlist is configured, strictly enforce it
    if (this.allowedChatIds.length > 0) {
      return this.allowedChatIds.includes(chatId);
    }

    // No allowlist: accept the registered chat ID (set by /start)
    if (this.chatId) {
      return chatId === this.chatId;
    }

    // No chat ID registered yet — only /start should proceed (handled in /start handler)
    return false;
  }

  isAutoApproveMode(): boolean {
    return this.autoApproveMode;
  }

  /**
   * Get display label for permission mode
   */
  private getModeLabel(mode: PermissionMode): string {
    switch (mode) {
      case 'plan': return '📋 Plan';
      case 'auto': return '⚡ Auto';
      case 'ask': return '❓ Ask';
      default: return '';
    }
  }

  getAutoApproveCount(): number {
    return this.autoApproveCount;
  }

  incrementAutoApproveCount(): void {
    this.autoApproveCount++;
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Set or replace the AI interpreter at runtime.
   */
  setInterpreter(interpreter: Interpreter | null): void {
    this.interpreter = interpreter;
  }

  /**
   * Get the current AI interpreter.
   */
  getInterpreter(): Interpreter | null {
    return this.interpreter;
  }

  /**
   * Build observation callbacks for the AI interpreter's observation tools.
   * These allow the AI to read terminal output, send keys, and list sessions.
   */
  buildObservationCallbacks(): ObservationCallbacks {
    return {
      getTerminalOutput: (sessionId: string, lines = 50) => {
        const context = this.sessionManager.getContext(sessionId, lines);
        return context
          .map(line => cleanTerminalOutput(line))
          .filter(l => l.length > 0)
          .join('\n')
          .slice(0, 3500);
      },
      sendKeys: (sessionId: string, keys: string) => {
        return this.sessionManager.sendInput(sessionId, keys);
      },
      listSessions: () => {
        return this.sessionManager.listSessions().map(s => ({
          id: s.id,
          status: s.status,
          task: s.task || '',
          cwd: s.cwd,
          ageMinutes: Math.round((Date.now() - s.createdAt.getTime()) / 1000 / 60),
          isActive: s.id === this.activeSessionId,
        }));
      },
    };
  }

  /**
   * Build interpretation context from current session state.
   */
  private buildInterpretationContext(): import('../ai/types.js').InterpretationContext {
    const activeSession = this.activeSessionId
      ? this.sessionManager.getSession(this.activeSessionId)
      : null;

    // Get recent output from active session (last 10 lines)
    let recentOutput: string[] = [];
    if (activeSession) {
      recentOutput = activeSession.buffer
        .slice(-10)
        .map(line => cleanTerminalOutput(line))
        .filter(line => line.length > 0);
    }

    // Check if there's a pending question
    let hasPendingQuestion = false;
    if (activeSession) {
      for (const pending of this.pendingQuestions.values()) {
        if (pending.sessionCwd === activeSession.cwd) {
          hasPendingQuestion = true;
          break;
        }
      }
    }

    return {
      hasActiveSession: !!activeSession && activeSession.status !== 'completed',
      activeSessionId: this.activeSessionId,
      activeSessionCwd: activeSession?.cwd || null,
      activeSessionTask: activeSession?.task || null,
      activeSessionStatus: activeSession?.status || null,
      recentOutput,
      recentFolders: getRecentFolders(),
      hasPendingQuestion,
      sessionCount: this.sessionManager.getActiveSessions().length,
    };
  }

  /**
   * Handle an AI action by routing to the appropriate handler.
   */
  private async handleAIAction(
    ctx: Context,
    action: AIAction,
    originalText: string
  ): Promise<void> {
    switch (action.type) {
      case 'spawn': {
        const task = action.task;
        const permissionMode = (action.permissionMode as PermissionMode) || 'default';

        if (action.cwd) {
          const cwdPath = expandPath(action.cwd);
          const fs = await import('fs');
          if (fs.existsSync(cwdPath) && fs.statSync(cwdPath).isDirectory()) {
            await this.executeSpawn(ctx, task, cwdPath, permissionMode);
          } else {
            // CWD doesn't exist, show folder selection instead
            await this.showFolderSelection(ctx, task, permissionMode);
          }
        } else {
          await this.showFolderSelection(ctx, task, permissionMode);
        }
        break;
      }

      case 'send_to_session': {
        if (this.activeSessionId) {
          const success = this.sessionManager.sendInput(
            this.activeSessionId,
            action.text + '\r\r'
          );
          if (success) {
            await ctx.react('\uD83D\uDC4D');
          } else {
            await ctx.reply('\u274C Failed to send to session.');
          }
        } else {
          await ctx.reply(
            '\u274C No active session. Use `/spawn` to start one.',
            { parse_mode: 'Markdown' }
          );
        }
        break;
      }

      case 'reply_directly': {
        await ctx.reply(action.text);
        break;
      }

      case 'clarify': {
        await ctx.reply(action.question);
        break;
      }

      case 'passthrough': {
        // Fall through to legacy handling
        await this.handleLegacyText(ctx, originalText);
        break;
      }
    }
  }

  /**
   * Legacy text handling (pre-AI behavior).
   * Sends text directly to the active session.
   */
  private async handleLegacyText(ctx: Context, text: string): Promise<void> {
    if (!this.activeSessionId) {
      await ctx.reply(
        '\uD83D\uDCAC No active session to send text to.\n\n' +
          'Use `/spawn <task>` to start one, or use commands like /help.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const success = this.sessionManager.sendInput(this.activeSessionId, text + '\r\r');

    if (success) {
      await ctx.react('\uD83D\uDC4D');
    } else {
      await ctx.reply('\u274C Failed to send to session.');
    }
  }

  /**
   * Record an action from PostToolUse hook
   */
  recordAction(action: RecordedAction): void {
    this.recordedActions.push(action);

    // Keep only the last MAX_ACTIONS
    if (this.recordedActions.length > this.MAX_ACTIONS) {
      this.recordedActions.shift();
    }

    // Find the session by cwd
    const session = this.sessionManager.findSessionByCwd(action.cwd);

    // Check for ExitPlanMode - transition from plan mode to default
    if (action.toolName === 'ExitPlanMode' && session && session.permissionMode === 'plan') {
      console.log(`[Bot] ExitPlanMode detected for session ${session.id}, transitioning to default mode`);
      this.sessionManager.setPermissionMode(session.id, 'default');

      if (this.chatId) {
        this.bot.api
          .sendMessage(
            this.chatId,
            `🔄 *Plan Approved*\n\n` +
              `Session \`${session.id}\` exited plan mode.\n` +
              `Now running in normal mode.`,
            { parse_mode: 'Markdown' }
          )
          .catch((err) => console.error('Failed to send mode transition notification:', err));
      }
      return;
    }

    // If this action matches the active session's cwd, notify via Telegram
    const activeSession = this.activeSessionId
      ? this.sessionManager.getSession(this.activeSessionId)
      : null;

    if (activeSession && action.cwd === activeSession.cwd && this.chatId) {
      // Send a brief notification for significant actions
      const notification = this.formatActionNotification(action);
      if (notification) {
        this.bot.api
          .sendMessage(this.chatId, notification, { parse_mode: 'Markdown' })
          .catch((err) => console.error('Failed to send action notification:', err));
      }
    }
  }

  /**
   * Format an action for notification (returns null for uninteresting actions)
   */
  private formatActionNotification(action: RecordedAction): string | null {
    const emoji = action.success ? '✅' : '❌';

    switch (action.toolName) {
      case 'Write':
        const writePath = action.toolInput.file_path as string;
        const fileName = writePath?.split('/').pop() || writePath;
        return `${emoji} *Created:* \`${fileName}\``;

      case 'Edit':
        const editPath = action.toolInput.file_path as string;
        const editName = editPath?.split('/').pop() || editPath;
        return `${emoji} *Edited:* \`${editName}\``;

      case 'Bash':
        const cmd = action.toolInput.command as string;
        // Only notify for interesting commands
        if (cmd && !cmd.startsWith('cd ') && cmd.length < 50) {
          return `${emoji} *Ran:* \`${cmd}\``;
        }
        return null;

      default:
        // Don't notify for reads, greps, etc.
        return null;
    }
  }

  /**
   * Get actions for a specific cwd (matching active session)
   */
  getActionsForCwd(cwd: string, limit = 20): RecordedAction[] {
    return this.recordedActions
      .filter((a) => a.cwd === cwd)
      .slice(-limit);
  }

  /**
   * Format action summary for /actions command
   */
  private formatActionSummary(action: RecordedAction): string {
    switch (action.toolName) {
      case 'Write': {
        const path = action.toolInput.file_path as string;
        const name = path?.split('/').pop() || path;
        return `Created \`${name}\``;
      }
      case 'Edit': {
        const path = action.toolInput.file_path as string;
        const name = path?.split('/').pop() || path;
        return `Edited \`${name}\``;
      }
      case 'Bash': {
        const cmd = action.toolInput.command as string;
        const truncated = cmd?.length > 40 ? cmd.slice(0, 40) + '...' : cmd;
        return `Ran \`${truncated}\``;
      }
      case 'Read': {
        const path = action.toolInput.file_path as string;
        const name = path?.split('/').pop() || path;
        return `Read \`${name}\``;
      }
      case 'Glob':
        return `Searched files: \`${action.toolInput.pattern}\``;
      case 'Grep':
        return `Searched for: \`${action.toolInput.pattern}\``;
      case 'Task':
        return `Spawned agent`;
      default:
        return `${action.toolName}`;
    }
  }

  /**
   * Handle AskUserQuestion from PreToolUse hook
   * Sends properly formatted UI to Telegram and stores pending state
   */
  async handleAskUserQuestion(
    requestId: string,
    questions: AskUserQuestionItem[],
    cwd: string
  ): Promise<void> {
    if (!this.chatId) return;

    console.log(`[Bot] Handling AskUserQuestion ${requestId} with ${questions.length} questions`);

    // Create pending question state
    const pending: PendingAskUserQuestion = {
      requestId,
      questions,
      sessionCwd: cwd,
      messageIds: [],
      selections: new Map(),
      createdAt: new Date(),
    };

    // Initialize selections - empty sets for each question
    for (let i = 0; i < questions.length; i++) {
      pending.selections.set(i, new Set());
    }

    // Send each question as a separate message
    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      const question = questions[qIdx];
      const isLast = qIdx === questions.length - 1;

      const messageId = await this.sendQuestionMessage(
        requestId,
        question,
        qIdx,
        isLast,
        pending.selections.get(qIdx) || new Set()
      );

      if (messageId) {
        pending.messageIds.push(messageId);
      }
    }

    this.pendingQuestions.set(requestId, pending);

    // Set timeout - auto-expire after 10 minutes
    setTimeout(() => {
      if (this.pendingQuestions.has(requestId)) {
        console.log(`[Bot] AskUserQuestion ${requestId} expired`);
        this.pendingQuestions.delete(requestId);
      }
    }, 10 * 60 * 1000);
  }

  /**
   * Send a single question message to Telegram with inline buttons
   */
  private async sendQuestionMessage(
    requestId: string,
    question: AskUserQuestionItem,
    questionIndex: number,
    isLastQuestion: boolean,
    selectedOptions: Set<number>
  ): Promise<number | null> {
    if (!this.chatId) return null;

    const emoji = question.multiSelect ? '☑️' : '📋';
    const typeLabel = question.multiSelect ? '(select multiple)' : '(select one)';

    let message = `${emoji} *${question.header}* ${typeLabel}\n\n`;
    message += `${question.question}\n\n`;

    // Build keyboard
    const keyboard = new InlineKeyboard();
    const optionsPerRow = 2;

    for (let i = 0; i < question.options.length; i++) {
      const option = question.options[i];
      const optionNum = i + 1;
      const isSelected = selectedOptions.has(i);

      // Show checkbox/radio state for multi-select
      let buttonLabel: string;
      if (question.multiSelect) {
        const check = isSelected ? '✓' : '○';
        buttonLabel = `${check} ${optionNum}. ${option.label}`;
      } else {
        buttonLabel = `${optionNum}️⃣ ${option.label}`;
      }

      // Truncate long labels
      if (buttonLabel.length > 30) {
        buttonLabel = buttonLabel.slice(0, 27) + '...';
      }

      const callbackData = `askq:${requestId}:${questionIndex}:${i}`;
      keyboard.text(buttonLabel, callbackData);

      // Add row break
      if ((i + 1) % optionsPerRow === 0 && i < question.options.length - 1) {
        keyboard.row();
      }
    }

    // Add "Other" option on new row
    keyboard.row();
    keyboard.text('✏️ Type custom...', `askq_other:${requestId}:${questionIndex}`);

    // Always add Submit button so user can submit from any question
    keyboard.row();
    keyboard.text('✅ Submit All', `askq_submit:${requestId}`);

    try {
      const sent = await this.bot.api.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      return sent.message_id;
    } catch (err) {
      console.error('[Bot] Failed to send question message:', err);
      return null;
    }
  }

  /**
   * Update a question message with new selection state
   */
  private async updateQuestionMessage(
    messageId: number,
    requestId: string,
    question: AskUserQuestionItem,
    questionIndex: number,
    isLastQuestion: boolean,
    selectedOptions: Set<number>
  ): Promise<void> {
    if (!this.chatId) return;

    const emoji = question.multiSelect ? '☑️' : '📋';
    const typeLabel = question.multiSelect ? '(select multiple)' : '(select one)';

    let message = `${emoji} *${question.header}* ${typeLabel}\n\n`;
    message += `${question.question}\n\n`;

    // Show current selections
    if (selectedOptions.size > 0) {
      const selectedLabels = Array.from(selectedOptions)
        .map(i => question.options[i]?.label || `Option ${i + 1}`)
        .join(', ');
      message += `_Selected: ${selectedLabels}_\n\n`;
    }

    // Build keyboard
    const keyboard = new InlineKeyboard();
    const optionsPerRow = 2;

    for (let i = 0; i < question.options.length; i++) {
      const option = question.options[i];
      const optionNum = i + 1;
      const isSelected = selectedOptions.has(i);

      let buttonLabel: string;
      if (question.multiSelect) {
        const check = isSelected ? '✓' : '○';
        buttonLabel = `${check} ${optionNum}. ${option.label}`;
      } else {
        buttonLabel = `${optionNum}️⃣ ${option.label}`;
      }

      if (buttonLabel.length > 30) {
        buttonLabel = buttonLabel.slice(0, 27) + '...';
      }

      const callbackData = `askq:${requestId}:${questionIndex}:${i}`;
      keyboard.text(buttonLabel, callbackData);

      if ((i + 1) % optionsPerRow === 0 && i < question.options.length - 1) {
        keyboard.row();
      }
    }

    keyboard.row();
    keyboard.text('✏️ Type custom...', `askq_other:${requestId}:${questionIndex}`);

    // Always add Submit button
    keyboard.row();
    keyboard.text('✅ Submit All', `askq_submit:${requestId}`);

    try {
      await this.bot.api.editMessageText(this.chatId, messageId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (err: unknown) {
      // Ignore "message not modified" errors - they're harmless
      const grammyErr = err as { description?: string };
      if (grammyErr.description?.includes('message is not modified')) {
        return;
      }
      console.error('[Bot] Failed to update question message:', err);
    }
  }

  /**
   * Build keystroke sequence for answering AskUserQuestion via PTY
   *
   * Claude Code's TUI behavior (from "Enter to select · ↑/↓ to navigate"):
   * - Arrow Up/Down to navigate between options within a question
   * - Enter to select an option and move to next question
   */
  private buildKeystrokesForAnswer(
    questions: AskUserQuestionItem[],
    selections: Map<number, Set<number>>,
    customTexts?: Map<number, string>
  ): string {
    let keystrokes = '';

    // ANSI escape sequences for arrow keys
    const DOWN = '\x1b[B';
    const UP = '\x1b[A';
    const ENTER = '\r';
    const SPACE = ' ';

    for (let q = 0; q < questions.length; q++) {
      const question = questions[q];
      const selected = selections.get(q) || new Set();

      // Check if this question has custom text input
      const isCustom = selected.has(-1);
      const customText = customTexts?.get(q);

      if (isCustom && customText) {
        // For custom text: navigate to "Type something" option (usually option index 2 or last-2)
        // This is a best-effort approach since we don't know exact TUI structure
        // Navigate to approximately the 3rd option (index 2) which is often "Type something"
        const typeOptionIndex = Math.min(2, question.options.length - 1);
        for (let i = 0; i < typeOptionIndex; i++) {
          keystrokes += DOWN;
        }
        keystrokes += ENTER; // Select "Type something"

        // Small delay for TUI to switch to text input mode (represented as empty string - PTY handles timing)
        keystrokes += customText; // Type the custom text
        keystrokes += ENTER; // Confirm the input
      } else if (question.multiSelect) {
        // For multi-select: navigate to each option and press Space to toggle
        const selectedIndices = Array.from(selected).filter(i => i >= 0).sort((a, b) => a - b);
        let currentPos = 0;

        for (const optIndex of selectedIndices) {
          // Move down to the option
          const moves = optIndex - currentPos;
          for (let i = 0; i < moves; i++) {
            keystrokes += DOWN;
          }
          keystrokes += SPACE; // Toggle this option
          currentPos = optIndex;
        }

        // Enter to confirm selections and move to next question
        keystrokes += ENTER;
      } else {
        // Single-select: navigate to selected option, then Enter
        const choice = selected.size > 0 ? Math.max(0, Array.from(selected)[0]) : 0;

        // Move down to the selected option (if not first)
        for (let i = 0; i < choice; i++) {
          keystrokes += DOWN;
        }

        // Enter to select and move to next question
        keystrokes += ENTER;
      }
    }

    return keystrokes;
  }

  /**
   * Submit answers to Claude Code via PTY keystrokes
   */
  private async submitAskUserQuestionAnswer(requestId: string): Promise<boolean> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) {
      console.error(`[Bot] No pending question for ${requestId}`);
      return false;
    }

    logger.info(`[Bot] Submitting AskUserQuestion ${requestId}`);
    logger.debug(`[Bot]   sessionCwd: ${pending.sessionCwd}`);
    logger.debug(`[Bot]   questions: ${pending.questions.length}`);
    for (let i = 0; i < pending.questions.length; i++) {
      const sel = pending.selections.get(i);
      logger.debug(`[Bot]   Q${i} "${pending.questions[i].header}": selected=[${sel ? Array.from(sel).join(',') : 'none'}]`);
    }

    // Find the session by cwd
    const session = this.sessionManager.findSessionByCwd(pending.sessionCwd);
    if (!session) {
      console.error(`[Bot] No session found for cwd ${pending.sessionCwd}`);
      // List available sessions for debugging
      const sessions = this.sessionManager.listSessions();
      console.error(`[Bot] Available sessions:`);
      for (const s of sessions) {
        console.error(`[Bot]   ${s.id}: cwd=${s.cwd}, status=${s.status}`);
      }
      return false;
    }

    console.log(`[Bot] Found session ${session.id}`);

    // Build keystrokes
    const keystrokes = this.buildKeystrokesForAnswer(
      pending.questions,
      pending.selections,
      pending.customTexts
    );
    logger.debug(`[Bot] Sending keystrokes for ${requestId}: ${JSON.stringify(keystrokes)}`);

    // Send to PTY
    const success = this.sessionManager.sendInput(session.id, keystrokes);

    if (success) {
      // Clean up pending state
      this.pendingQuestions.delete(requestId);

      // Update Telegram messages to show completion
      if (this.chatId) {
        for (const msgId of pending.messageIds) {
          try {
            await this.bot.api.editMessageText(
              this.chatId,
              msgId,
              `✅ *Answer submitted*\n\nRequest: \`${requestId}\``,
              { parse_mode: 'Markdown' }
            );
          } catch {
            // Message might be too old or already edited
          }
        }
      }
    }

    return success;
  }

  private setupSessionHandlers() {
    // Handle prompts from PTY sessions
    this.sessionManager.on('prompt', async (sessionId: string, prompt: ParsedPrompt) => {
      if (!this.chatId) return;

      const session = this.sessionManager.getSession(sessionId);

      // Handle completion notifications specially
      if (prompt.type === 'completion') {
        const duration = session?.createdAt
          ? this.formatDuration(Date.now() - session.createdAt.getTime())
          : 'unknown';
        const folderName = session?.cwd ? session.cwd.split('/').pop() : 'unknown';

        await this.bot.api.sendMessage(
          this.chatId,
          `✨ *Task Completed*\n\n` +
            `📁 Folder: \`${folderName}\`\n` +
            `⏱️ Duration: ${duration}\n` +
            `🔑 Session: \`${sessionId}\`\n\n` +
            `_Session is still active - send a message to continue or /kill to end._`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Skip if we already have a pending AskUserQuestion for this session's cwd
      // (the structured data from PreToolUse hook is much better than PTY parsing)
      if (session) {
        for (const pending of this.pendingQuestions.values()) {
          if (pending.sessionCwd === session.cwd) {
            console.log(`[Bot] Skipping PTY prompt detection - already have pending AskUserQuestion for ${session.cwd}`);
            return;
          }
        }
      }

      await this.sendPromptToTelegram(sessionId, prompt);
    });

    // Handle session completion
    this.sessionManager.on('exit', async (sessionId: string, exitCode: number) => {
      if (!this.chatId) return;

      const emoji = exitCode === 0 ? '✅' : '❌';
      await this.bot.api.sendMessage(
        this.chatId,
        `${emoji} *Session Completed*\n\n` +
          `Session: \`${sessionId}\`\n` +
          `Exit code: ${exitCode}`,
        { parse_mode: 'Markdown' }
      );

      // Clear active session if it was this one
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
      }
    });
  }

  /**
   * Send a prompt from a PTY session to Telegram with buttons
   */
  private async sendPromptToTelegram(sessionId: string, prompt: ParsedPrompt) {
    if (!this.chatId) return;

    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    // Build message based on prompt type
    let message = `📋 *Question from Session*\n\n`;

    if (prompt.question) {
      message += `${prompt.question}\n\n`;
    }

    // Build keyboard with options
    const keyboard = new InlineKeyboard();

    if (prompt.options && prompt.options.length > 0) {
      for (const option of prompt.options) {
        const emoji = this.getOptionEmoji(option.index);
        keyboard.text(`${emoji} ${option.label}`, `session_opt:${sessionId}:${option.index}`);
        // Add row break every 2 options for better layout
        if (option.index % 2 === 0) {
          keyboard.row();
        }
      }

      // If not on a new row, add one
      if (prompt.options.length % 2 !== 0) {
        keyboard.row();
      }
    }

    // Add "Other" option for text input
    keyboard.text('✏️ Other', `session_other:${sessionId}`);

    await this.bot.api.sendMessage(this.chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  private getOptionEmoji(index: number): string {
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    return emojis[index - 1] || `${index}.`;
  }

  /**
   * Format milliseconds as human readable duration
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Show folder selection keyboard for /spawn
   */
  private async showFolderSelection(
    ctx: Context,
    task: string,
    permissionMode: PermissionMode
  ): Promise<void> {
    const recentFolders = getRecentFolders();
    const defaultCwd = this.getDefaultCwd?.() || process.cwd();

    // Build keyboard
    const keyboard = new InlineKeyboard();

    // Add recent folders (up to 5)
    const foldersToShow = recentFolders.slice(0, 5);

    // If default CWD is not in recent folders, add it at the end
    if (!foldersToShow.includes(defaultCwd)) {
      foldersToShow.push(defaultCwd);
    }

    for (let i = 0; i < foldersToShow.length; i++) {
      const folder = foldersToShow[i];
      const shortLabel = shortenPath(folder);
      // Truncate if too long
      const label = shortLabel.length > 35 ? '...' + shortLabel.slice(-32) : shortLabel;
      keyboard.text(`📁 ${label}`, `spawn_folder:${i}:${folder}`);
      keyboard.row();
    }

    // Add custom path option
    keyboard.text('✏️ Type custom path...', 'spawn_custom');
    keyboard.row();

    // Add cancel button
    keyboard.text('❌ Cancel', 'spawn_cancel');

    // Build message
    let message = `📂 *Select Working Directory*\n\n`;
    message += `*Task:* ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}\n`;
    if (permissionMode !== 'default') {
      message += `*Mode:* ${this.getModeLabel(permissionMode)}\n`;
    }
    message += `\nSelect a folder or type a custom path:`;

    const sent = await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });

    // Store pending spawn request
    this.pendingSpawn = {
      task,
      permissionMode,
      messageId: sent.message_id,
      createdAt: new Date(),
    };

    // Set timeout - auto-expire after 5 minutes
    setTimeout(() => {
      if (this.pendingSpawn?.messageId === sent.message_id) {
        this.pendingSpawn = null;
        this.pendingSpawnCustomPath = false;
        // Try to update the message to show expiration
        if (this.chatId) {
          this.bot.api.editMessageText(
            this.chatId,
            sent.message_id,
            `⏰ *Spawn request expired*\n\nPlease use /spawn again.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Execute spawn with the selected folder
   */
  private async executeSpawn(
    ctx: Context,
    task: string,
    cwd: string,
    permissionMode: PermissionMode
  ): Promise<void> {
    try {
      const session = this.sessionManager.spawn(task, cwd, permissionMode);
      this.activeSessionId = session.id;

      // Add to recent folders
      addRecentFolder(cwd);

      let modeLabel = '';
      if (permissionMode === 'plan') {
        modeLabel = '📋 Plan Mode';
      } else if (permissionMode === 'auto') {
        modeLabel = '⚡ Auto Mode';
      } else if (permissionMode === 'ask') {
        modeLabel = '❓ Ask Mode';
      }

      let message = `🚀 *Session Started*\n\n` +
        `ID: \`${session.id}\`\n`;

      if (modeLabel) {
        message += `Mode: ${modeLabel}\n`;
      }

      message += `Task: ${task}\n` +
        `Directory: \`${shortenPath(cwd)}\`\n\n` +
        `Claude Code is now running. You'll receive prompts here.`;

      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Failed to spawn session:', err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Failed to start session.\n\nError: ${errorMsg}`);
    }
  }

  private setupHandlers() {
    // /start command - register chat ID
    this.bot.command('start', async (ctx) => {
      const incomingChatId = ctx.chat.id.toString();

      // If an allowlist is configured, check it
      if (this.allowedChatIds.length > 0 && !this.allowedChatIds.includes(incomingChatId)) {
        console.log(`Rejected /start from unauthorized chat ID: ${incomingChatId}`);
        await ctx.reply(`You are not authorized to use this bot.`);
        return;
      }

      // If a chat ID is already registered and the incoming one differs, reject
      // (unless the incoming one is in the allowlist, which is checked above)
      if (this.chatId && this.chatId !== incomingChatId && this.allowedChatIds.length === 0) {
        console.log(`Rejected /start from chat ID ${incomingChatId} (already registered to ${this.chatId})`);
        await ctx.reply(`This bot is already connected to another chat. Access denied.`);
        return;
      }

      this.chatId = incomingChatId;

      // Persist the chat ID
      if (this.onChatIdChange) {
        this.onChatIdChange(this.chatId);
      }

      await ctx.reply(
        `🤖 *ClaudeBridge Connected*\n\n` +
          `Chat ID: \`${this.chatId}\`\n\n` +
          `You'll receive approval requests here when Claude Code needs permission.\n\n` +
          `*Approval:*\n` +
          `/status - Status and pending approvals\n` +
          `/allowall - Enable auto-approve\n` +
          `/stopallow - Disable auto-approve\n\n` +
          `*Sessions:*\n` +
          `/spawn <task> - Start Claude session\n` +
          `/sessions - List active sessions\n` +
          `/help - Full command list`,
        { parse_mode: 'Markdown' }
      );
      console.log(`Telegram connected. Chat ID: ${this.chatId}`);
    });

    // /status command - enhanced with mode, sessions, and console output
    this.bot.command('status', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const modeEmoji = this.autoApproveMode ? '⚡' : '🔒';
      const modeText = this.autoApproveMode ? 'Auto-Approve' : 'Manual';
      const modeInfo = this.autoApproveMode
        ? `Mode since: ${this.autoApproveStartTime?.toLocaleTimeString()}\nAuto-approved: ${this.autoApproveCount} requests`
        : '';

      let statusMsg =
        `${modeEmoji} *Mode:* ${modeText}\n` +
        (modeInfo ? modeInfo + '\n' : '') +
        `\n`;

      // Active sessions
      const activeSessions = this.sessionManager.getActiveSessions();
      if (activeSessions.length > 0) {
        statusMsg += `🖥️ *Active Sessions:* ${activeSessions.length}\n`;
        for (const session of activeSessions) {
          const active = session.id === this.activeSessionId ? ' ←' : '';
          statusMsg += `• \`${session.id}\`${active}: ${session.status}\n`;
        }
        statusMsg += '\n';
      }

      // Pending approvals
      if (this.pendingApprovals.size === 0) {
        statusMsg += `✅ No pending approval requests.\n`;
      } else {
        const list = Array.from(this.pendingApprovals.values())
          .map((req) => `• \`${req.id}\`: ${req.toolName}`)
          .join('\n');
        statusMsg += `⏳ *Pending Approvals:*\n${list}\n`;
      }

      // Last 5 lines of console output
      if (this.getConsoleOutput) {
        const lines = this.getConsoleOutput();
        if (lines.length > 0) {
          statusMsg += `\n📋 *Recent Output:*\n\`\`\`\n${lines.slice(-5).join('\n')}\n\`\`\``;
        }
      }

      await ctx.reply(statusMsg, { parse_mode: 'Markdown' });
    });

    // /allowall command - enable auto-approve mode
    this.bot.command('allowall', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      if (this.autoApproveMode) {
        await ctx.reply(
          `⚡ Auto-approve mode is already active.\n` +
            `Active since: ${this.autoApproveStartTime?.toLocaleTimeString()}\n` +
            `Requests auto-approved: ${this.autoApproveCount}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      this.autoApproveMode = true;
      this.autoApproveStartTime = new Date();
      this.autoApproveCount = 0;

      await ctx.reply(
        `⚡ *Auto-Approve Mode ENABLED*\n\n` +
          `All permission requests will be automatically approved.\n\n` +
          `⚠️ Use with caution! Only enable when you trust the current task.\n\n` +
          `Send /stopallow to disable.`,
        { parse_mode: 'Markdown' }
      );
      console.log('Auto-approve mode enabled via /allowall');
    });

    // /stopallow command - disable auto-approve mode
    this.bot.command('stopallow', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      if (!this.autoApproveMode) {
        await ctx.reply(`🔒 Manual mode is already active.`);
        return;
      }

      const count = this.autoApproveCount;
      const duration = this.autoApproveStartTime
        ? Math.round((Date.now() - this.autoApproveStartTime.getTime()) / 1000 / 60)
        : 0;

      this.autoApproveMode = false;
      this.autoApproveStartTime = null;
      this.autoApproveCount = 0;

      await ctx.reply(
        `🔒 *Auto-Approve Mode DISABLED*\n\n` +
          `Returning to manual approval.\n\n` +
          `📊 Session stats:\n` +
          `• Duration: ${duration} minutes\n` +
          `• Requests auto-approved: ${count}`,
        { parse_mode: 'Markdown' }
      );
      console.log(`Auto-approve mode disabled. ${count} requests were auto-approved.`);
    });

    // /help command
    this.bot.command('help', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      await ctx.reply(
        `🤖 *ClaudeBridge Help*\n\n` +
          `*Session Commands:*\n` +
          `/spawn <task> - Start session (shows folder picker)\n` +
          `/spawn --cwd ~/path <task> - Spawn in specific folder\n` +
          `/spawn --plan <task> - Plan mode (no actions)\n` +
          `/spawn --auto <task> - Auto-approve mode\n` +
          `/sessions - List active sessions\n` +
          `/kill [id] - Terminate session\n\n` +
          `*Terminal Commands:*\n` +
          `/screenshot - Capture terminal as image\n` +
          `/context [lines] - Get terminal text output\n` +
          `/input <text> - Send raw text to session\n` +
          `/keys <key...> - Send keystrokes (see /keys help)\n\n` +
          `*AI Commands:*\n` +
          `/ai - Show AI interpreter status\n` +
          `/ai on|off - Enable/disable AI\n` +
          `/ai clear - Clear AI memory\n\n` +
          `*Other Commands:*\n` +
          `/status - Show current status\n` +
          `/actions [n] - Show completed actions\n` +
          `/folders - Manage recent folders\n` +
          `/allowall - Enable auto-approve mode\n` +
          `/stopallow - Disable auto-approve\n\n` +
          `*Interaction:*\n` +
          `💬 Type text → AI interprets (if enabled)\n` +
          `🔘 Tap buttons → answer prompts\n\n` +
          `*Permission Modes:*\n` +
          `📋 Plan - Plans only, no execution\n` +
          `⚡ Auto - Auto-approve all actions\n` +
          `❓ Ask - Always asks permission`,
        { parse_mode: 'Markdown' }
      );
    });

    // /spawn command - start new Claude Code session
    this.bot.command('spawn', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      let input = ctx.message?.text?.replace(/^\/spawn\s*/, '').trim() || '';

      // Normalize dashes (Telegram on mobile converts -- to em-dash —)
      input = input.replace(/^[—–]/, '--');  // Convert em-dash or en-dash to double hyphen

      // Parse permission mode flags
      let permissionMode: PermissionMode = 'default';

      if (input.startsWith('--plan ') || input.startsWith('-plan ')) {
        permissionMode = 'plan';
        input = input.replace(/^--?plan\s+/, '');
      } else if (input.startsWith('--auto ') || input.startsWith('-auto ')) {
        permissionMode = 'auto';
        input = input.replace(/^--?auto\s+/, '');
      } else if (input.startsWith('--ask ') || input.startsWith('-ask ')) {
        permissionMode = 'ask';
        input = input.replace(/^--?ask\s+/, '');
      }

      // Check for --cwd flag for power users (bypass folder selection)
      const cwdMatch = input.match(/--cwd\s+(\S+)\s*/);
      if (cwdMatch) {
        const cwdPath = expandPath(cwdMatch[1]);
        input = input.replace(/--cwd\s+\S+\s*/, '').trim();
        const task = input;

        if (!task) {
          await ctx.reply(
            `❌ Please provide a task.\n\n` +
              `*Usage:* \`/spawn <task> --cwd /path\``,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        if (task.length > 2000) {
          await ctx.reply(`❌ Task description is too long (${task.length} chars). Maximum is 2000 characters.`);
          return;
        }

        // Validate path exists
        const fs = await import('fs');
        if (!fs.existsSync(cwdPath) || !fs.statSync(cwdPath).isDirectory()) {
          await ctx.reply(`❌ Directory does not exist: \`${cwdPath}\``);
          return;
        }

        await this.executeSpawn(ctx, task, cwdPath, permissionMode);
        return;
      }

      const task = input.trim();

      if (!task) {
        await ctx.reply(
          `❌ Please provide a task.\n\n` +
            `*Usage:*\n` +
            `\`/spawn <task>\` - Normal mode\n` +
            `\`/spawn --plan <task>\` - Plan mode (no actions)\n` +
            `\`/spawn --auto <task>\` - Auto-approve mode\n` +
            `\`/spawn --ask <task>\` - Always ask mode\n` +
            `\`/spawn <task> --cwd ~/path\` - Specify folder directly\n\n` +
            `*Example:*\n` +
            `\`/spawn --plan Design the new auth system\``,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (task.length > 2000) {
        await ctx.reply(`❌ Task description is too long (${task.length} chars). Maximum is 2000 characters.`);
        return;
      }

      // Show folder selection
      await this.showFolderSelection(ctx, task, permissionMode);
    });

    // /context command - get recent output from session
    this.bot.command('context', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const args = ctx.message?.text?.replace(/^\/context\s*/, '').trim();
      const lines = parseInt(args || '20', 10);

      const sessionId = this.activeSessionId;
      if (!sessionId) {
        await ctx.reply(
          `❌ No active session.\n\n` + `Use \`/spawn <task>\` to start one.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const context = this.sessionManager.getContext(sessionId, lines);
      if (context.length === 0) {
        await ctx.reply(`📋 No output yet from session \`${sessionId}\`.`, {
          parse_mode: 'Markdown',
        });
        return;
      }

      // Clean ANSI codes and format for display
      const rawOutput = context.join('\n');
      const cleanedOutput = cleanTerminalOutput(rawOutput);

      if (cleanedOutput.length === 0) {
        await ctx.reply(`📋 Session \`${sessionId}\` has output but it's mostly control codes.`, {
          parse_mode: 'Markdown',
        });
        return;
      }

      // Truncate and send (no markdown parsing to avoid issues with special chars)
      const truncated = cleanedOutput.slice(0, 3500);
      await ctx.reply(`📋 Recent Output (${sessionId}):\n\n${truncated}`);
    });

    // /sessions command - list active sessions
    this.bot.command('sessions', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const sessions = this.sessionManager.listSessions();

      if (sessions.length === 0) {
        await ctx.reply(`📋 No sessions.\n\nUse \`/spawn <task>\` to start one.`, {
          parse_mode: 'Markdown',
        });
        return;
      }

      let message = `📋 *Sessions* (${sessions.length})\n\n`;

      for (const session of sessions) {
        const statusEmoji =
          session.status === 'active'
            ? '🟢'
            : session.status === 'waiting'
              ? '🟡'
              : '⚫';
        const active = session.id === this.activeSessionId ? ' ← active' : '';
        const age = Math.round((Date.now() - session.createdAt.getTime()) / 1000 / 60);
        const modeLabel = this.getModeLabel(session.permissionMode);

        message +=
          `${statusEmoji} \`${session.id}\`${active}\n` +
          `   Task: ${session.task.slice(0, 40)}${session.task.length > 40 ? '...' : ''}\n` +
          `   Age: ${age} min | Status: ${session.status}` + (modeLabel ? ` | ${modeLabel}` : '') + `\n\n`;
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });
    });

    // /kill command - terminate a session
    this.bot.command('kill', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const sessionId = ctx.message?.text?.replace(/^\/kill\s*/, '').trim();

      if (!sessionId) {
        // Kill active session if no ID provided
        if (this.activeSessionId) {
          const killed = this.sessionManager.kill(this.activeSessionId);
          if (killed) {
            await ctx.reply(`☠️ Killed session \`${this.activeSessionId}\`.`, {
              parse_mode: 'Markdown',
            });
            this.activeSessionId = null;
          }
          return;
        }

        await ctx.reply(
          `❌ No session to kill.\n\n` +
            `Usage: \`/kill <session-id>\` or \`/kill\` to kill active session.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const killed = this.sessionManager.kill(sessionId);
      if (killed) {
        await ctx.reply(`☠️ Killed session \`${sessionId}\`.`, {
          parse_mode: 'Markdown',
        });
        if (this.activeSessionId === sessionId) {
          this.activeSessionId = null;
        }
      } else {
        await ctx.reply(`❌ Session \`${sessionId}\` not found.`, {
          parse_mode: 'Markdown',
        });
      }
    });

    // /folders command - manage recent folder history
    this.bot.command('folders', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const args = ctx.message?.text?.replace(/^\/folders\s*/, '').trim() || '';

      // /folders clear - clear all history
      if (args === 'clear') {
        clearRecentFolders();
        await ctx.reply(`✅ Folder history cleared.`);
        return;
      }

      // /folders remove <n> - remove folder at index
      const removeMatch = args.match(/^remove\s+(\d+)$/);
      if (removeMatch) {
        const index = parseInt(removeMatch[1], 10);
        const folders = getRecentFolders();

        if (index < 0 || index >= folders.length) {
          await ctx.reply(`❌ Invalid index. Use a number from 0 to ${folders.length - 1}.`);
          return;
        }

        const removedFolder = folders[index];
        const success = removeRecentFolder(index);
        if (success) {
          await ctx.reply(`✅ Removed: \`${shortenPath(removedFolder)}\``, {
            parse_mode: 'Markdown',
          });
        } else {
          await ctx.reply(`❌ Failed to remove folder.`);
        }
        return;
      }

      // /folders - list all recent folders
      const folders = getRecentFolders();

      if (folders.length === 0) {
        await ctx.reply(
          `📂 *Recent Folders*\n\n` +
            `No folders in history yet.\n\n` +
            `Folders are saved when you use /spawn.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let message = `📂 *Recent Folders*\n\n`;
      for (let i = 0; i < folders.length; i++) {
        message += `\`${i}\` ${shortenPath(folders[i])}\n`;
      }
      message += `\n*Commands:*\n`;
      message += `\`/folders clear\` - Clear all\n`;
      message += `\`/folders remove <n>\` - Remove folder at index`;

      await ctx.reply(message, { parse_mode: 'Markdown' });
    });

    // /ai command - manage AI interpreter
    this.bot.command('ai', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const args = ctx.message?.text?.replace(/^\/ai\s*/, '').trim().toLowerCase();

      if (!args || args === 'status') {
        // Show AI status
        const config = loadConfig();
        const aiConfig = config.ai;
        if (!aiConfig || !aiConfig.enabled) {
          await ctx.reply(
            `\uD83E\uDD16 *AI Interpreter: Disabled*\n\n` +
              `To enable, add an \`ai\` section to your config:\n` +
              `\`~/.claude-bridge/config.json\`\n\n` +
              `\`\`\`\n{\n  "ai": {\n    "enabled": true,\n    "provider": "openai",\n    "apiKey": "sk-..."\n  }\n}\n\`\`\``,
            { parse_mode: 'Markdown' }
          );
        } else {
          const model = aiConfig.model || (aiConfig.provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-20250514');
          const chatId = ctx.chat?.id?.toString() || '';
          const stats = this.interpreter?.getMemoryStats(chatId);
          let memoryLine = '';
          if (stats && stats.messageCount > 0) {
            memoryLine = `\nMemory: ${stats.messageCount} messages, ~${stats.estimatedTokens} tokens${stats.hasSummary ? ' [has summary]' : ''}`;
          }
          await ctx.reply(
            `\uD83E\uDD16 *AI Interpreter: ${this.interpreter?.isAvailable() ? 'Active' : 'Configured but inactive'}*\n\n` +
              `Provider: \`${aiConfig.provider}\`\n` +
              `Model: \`${model}\`\n` +
              `Temperature: ${aiConfig.temperature ?? 0.3}\n` +
              `Max conversation messages: ${aiConfig.maxConversationMessages ?? 50}` +
              memoryLine,
            { parse_mode: 'Markdown' }
          );
        }
        return;
      }

      if (args === 'on') {
        const config = loadConfig();
        if (!config.ai?.apiKey) {
          await ctx.reply(
            `\u274C Cannot enable AI: no API key configured.\n\n` +
              `Add \`ai.apiKey\` to \`~/.claude-bridge/config.json\` first.`
          );
          return;
        }
        saveConfig({ ai: { ...config.ai, enabled: true } });
        // Re-initialize interpreter
        try {
          const { Interpreter } = await import('../ai/interpreter.js');
          const updatedConfig = loadConfig();
          this.interpreter = new Interpreter(updatedConfig.ai!, this.buildObservationCallbacks());
          await ctx.reply(`\u2705 AI interpreter enabled.`);
        } catch (err) {
          logger.error('[Bot] Failed to initialize AI interpreter:', err);
          await ctx.reply(`\u274C Failed to initialize AI interpreter.`);
        }
        return;
      }

      if (args === 'off') {
        const config = loadConfig();
        if (config.ai) {
          saveConfig({ ai: { ...config.ai, enabled: false } });
        }
        this.interpreter = null;
        await ctx.reply(`\u2705 AI interpreter disabled. Messages will be sent directly to sessions.`);
        return;
      }

      if (args === 'clear') {
        const chatId = ctx.chat?.id?.toString() || '';
        this.interpreter?.clearMemory(chatId);
        await ctx.reply(`\u2705 AI conversation memory cleared.`);
        return;
      }

      if (args === 'compact') {
        if (!this.interpreter?.isAvailable()) {
          await ctx.reply(`\u274C AI interpreter is not active.`);
          return;
        }
        const chatId = ctx.chat?.id?.toString() || '';
        const context = this.buildInterpretationContext();
        const result = await this.interpreter.compactMemory(chatId, context);
        await ctx.reply(result);
        return;
      }

      await ctx.reply(
        `\uD83E\uDD16 *AI Commands:*\n\n` +
          `/ai - Show AI status\n` +
          `/ai on - Enable AI interpreter\n` +
          `/ai off - Disable AI interpreter\n` +
          `/ai clear - Clear conversation memory\n` +
          `/ai compact - Compact conversation memory`,
        { parse_mode: 'Markdown' }
      );
    });

    // /keys command - send specific keystrokes for testing TUI navigation
    this.bot.command('keys', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const args = ctx.message?.text?.replace(/^\/keys\s*/, '').toLowerCase().split(/\s+/) || [];

      if (!this.activeSessionId) {
        await ctx.reply(`❌ No active session.`);
        return;
      }

      if (args.length === 0 || args[0] === 'help') {
        await ctx.reply(
          `🎹 *Key Commands*\n\n` +
            `\`/keys down\` - Arrow down (↓)\n` +
            `\`/keys up\` - Arrow up (↑)\n` +
            `\`/keys enter\` - Enter key (⏎)\n` +
            `\`/keys tab\` - Tab key (⇥)\n` +
            `\`/keys shift+tab\` - Shift+Tab (cycle edits)\n` +
            `\`/keys space\` - Space bar\n` +
            `\`/keys esc\` - Escape key\n` +
            `\`/keys ctrl+c\` - Interrupt (Ctrl+C)\n` +
            `\`/keys 1\` - Number 1 (etc.)\n\n` +
            `*Combos:*\n` +
            `\`/keys down down enter\` - Multiple keys\n` +
            `\`/keys 1 enter\` - Number then enter`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let keystrokes = '';
      const keyMap: Record<string, string> = {
        'down': '\x1b[B',
        'up': '\x1b[A',
        'left': '\x1b[D',
        'right': '\x1b[C',
        'enter': '\r',
        'return': '\r',
        'tab': '\t',
        'shift+tab': '\x1b[Z',  // Shift+Tab (reverse tab)
        'shifttab': '\x1b[Z',
        'space': ' ',
        'esc': '\x1b',
        'escape': '\x1b',
        'ctrl+c': '\x03',  // Interrupt
        'ctrlc': '\x03',
        '1': '1',
        '2': '2',
        '3': '3',
        '4': '4',
        '5': '5',
        '6': '6',
        '7': '7',
        '8': '8',
        '9': '9',
        '0': '0',
      };

      const sentKeys: string[] = [];
      for (const arg of args) {
        if (keyMap[arg]) {
          keystrokes += keyMap[arg];
          sentKeys.push(arg);
        } else {
          await ctx.reply(`❌ Unknown key: \`${arg}\`. Use \`/keys help\` for options.`, {
            parse_mode: 'Markdown',
          });
          return;
        }
      }

      const success = this.sessionManager.sendInput(this.activeSessionId, keystrokes);
      if (success) {
        await ctx.reply(`🎹 Sent: ${sentKeys.join(' + ')}`);
      } else {
        await ctx.reply(`❌ Failed to send keys.`);
      }
    });

    // /input command - send raw input to active session
    this.bot.command('input', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const text = ctx.message?.text?.replace(/^\/input\s*/, '');

      if (!this.activeSessionId) {
        await ctx.reply(
          `❌ No active session.\n\n` + `Use \`/spawn <task>\` to start one.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (!text) {
        await ctx.reply(
          `❌ Please provide input text.\n\n` + `Usage: \`/input <text>\``,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Send with carriage return (Enter key in PTY)
      const success = this.sessionManager.sendInput(this.activeSessionId, text + '\r');
      if (success) {
        await ctx.reply(`➡️ Sent to \`${this.activeSessionId}\`: ${text}`, {
          parse_mode: 'Markdown',
        });
      } else {
        await ctx.reply(`❌ Failed to send input.`, { parse_mode: 'Markdown' });
      }
    });

    // /actions command - show completed actions for active session
    this.bot.command('actions', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const args = ctx.message?.text?.replace(/^\/actions\s*/, '').trim();
      const limit = parseInt(args || '10', 10);

      if (!this.activeSessionId) {
        await ctx.reply(
          `❌ No active session.\n\n` + `Use \`/spawn <task>\` to start one.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const session = this.sessionManager.getSession(this.activeSessionId);
      if (!session) {
        await ctx.reply(`❌ Session not found.`);
        return;
      }

      const actions = this.getActionsForCwd(session.cwd, limit);

      if (actions.length === 0) {
        await ctx.reply(
          `📝 No actions recorded yet for this session.\n\n` +
            `_Actions are captured via PostToolUse hooks._`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let message = `📝 *Actions* (${this.activeSessionId})\n\n`;

      for (const action of actions) {
        const emoji = action.success ? '✅' : '❌';
        const time = action.timestamp.toLocaleTimeString();
        const summary = this.formatActionSummary(action);
        message += `${emoji} \`${time}\` ${summary}\n`;
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });
    });

    // /screenshot command - capture terminal as image
    this.bot.command('screenshot', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      if (!this.activeSessionId) {
        await ctx.reply(
          `❌ No active session.\n\n` + `Use \`/spawn <task>\` to start one.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const rawOutput = this.sessionManager.getRawOutput(this.activeSessionId);

      if (!rawOutput || rawOutput.length < 10) {
        await ctx.reply(`📷 No output to capture yet.`);
        return;
      }

      try {
        // Send "uploading photo" status
        await ctx.replyWithChatAction('upload_photo');

        // Clean the output, remove control chars, and get last portion
        const cleanedOutput = sanitizeForSvg(cleanTerminalOutput(rawOutput.slice(-4000)));

        // Split into lines and limit
        const lines = cleanedOutput.split('\n').slice(-40);

        // Create SVG manually
        const fontSize = 14;
        const lineHeight = 20;
        const padding = 20;
        const charWidth = 8.4; // Approximate monospace char width

        // Calculate dimensions
        const maxLineLength = Math.max(...lines.map(l => l.length), 40);
        const width = Math.min(Math.max(maxLineLength * charWidth + padding * 2, 400), 1200);
        const height = lines.length * lineHeight + padding * 2;

        // Escape text for SVG
        const escapeXml = (text: string) =>
          text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');

        // Build SVG with text lines
        const textLines = lines
          .map(
            (line, i) =>
              `<text x="${padding}" y="${padding + (i + 1) * lineHeight}" fill="#d4d4d4">${escapeXml(line)}</text>`
          )
          .join('\n');

        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#1e1e1e"/>
  <style>
    text {
      font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
      font-size: ${fontSize}px;
      white-space: pre;
    }
  </style>
  ${textLines}
</svg>`;

        // Convert SVG to PNG
        const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

        // Send the image
        await ctx.replyWithPhoto(new InputFile(pngBuffer, 'terminal.png'), {
          caption: `📷 Terminal (${this.activeSessionId}) - ${lines.length} lines`,
        });
      } catch (err) {
        console.error('Screenshot failed:', err);
        await ctx.reply(
          `❌ Failed to capture screenshot.\n\nError: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    // Handle callback queries (button presses)
    this.bot.on('callback_query:data', async (ctx) => {
      if (!this.isAuthorized(ctx)) {
        await ctx.answerCallbackQuery({ text: 'Unauthorized' });
        return;
      }
      const data = ctx.callbackQuery.data;
      const parts = data.split(':');
      const action = parts[0];

      // Handle spawn folder selection
      if (action === 'spawn_folder') {
        const [, , folderPath] = parts;
        const fullPath = parts.slice(2).join(':'); // Handle paths with colons

        if (!this.pendingSpawn) {
          await ctx.answerCallbackQuery({ text: 'Request expired. Use /spawn again.' });
          return;
        }

        const { task, permissionMode, messageId } = this.pendingSpawn;
        this.pendingSpawn = null;
        this.pendingSpawnCustomPath = false;

        // Update the selection message
        if (this.chatId) {
          await this.bot.api.editMessageText(
            this.chatId,
            messageId,
            `📂 Selected: \`${shortenPath(fullPath)}\``,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }

        await this.executeSpawn(ctx, task, fullPath, permissionMode);
        await ctx.answerCallbackQuery({ text: 'Starting session...' });
        return;
      }

      // Handle spawn custom path request
      if (action === 'spawn_custom') {
        if (!this.pendingSpawn) {
          await ctx.answerCallbackQuery({ text: 'Request expired. Use /spawn again.' });
          return;
        }

        this.pendingSpawnCustomPath = true;

        await ctx.answerCallbackQuery({
          text: 'Type the folder path as a message',
          show_alert: true,
        });
        return;
      }

      // Handle spawn cancel
      if (action === 'spawn_cancel') {
        const messageId = this.pendingSpawn?.messageId;
        this.pendingSpawn = null;
        this.pendingSpawnCustomPath = false;

        if (this.chatId && messageId) {
          await this.bot.api.editMessageText(
            this.chatId,
            messageId,
            `❌ *Spawn cancelled*`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }

        await ctx.answerCallbackQuery({ text: 'Cancelled' });
        return;
      }

      // Handle AskUserQuestion option selection
      if (action === 'askq') {
        const [, requestId, questionIndexStr, optionIndexStr] = parts;
        const questionIndex = parseInt(questionIndexStr, 10);
        const optionIndex = parseInt(optionIndexStr, 10);

        const pending = this.pendingQuestions.get(requestId);
        if (!pending) {
          await ctx.answerCallbackQuery({ text: 'Question expired or not found' });
          return;
        }

        const question = pending.questions[questionIndex];
        if (!question) {
          await ctx.answerCallbackQuery({ text: 'Invalid question' });
          return;
        }

        const selections = pending.selections.get(questionIndex) || new Set();

        if (question.multiSelect) {
          // Toggle selection
          if (selections.has(optionIndex)) {
            selections.delete(optionIndex);
          } else {
            selections.add(optionIndex);
          }
          pending.selections.set(questionIndex, selections);

          // Update the message to reflect new state
          const messageId = pending.messageIds[questionIndex];
          if (messageId) {
            await this.updateQuestionMessage(
              messageId,
              requestId,
              question,
              questionIndex,
              questionIndex === pending.questions.length - 1,
              selections
            );
          }

          await ctx.answerCallbackQuery({ text: `Toggled: ${question.options[optionIndex]?.label}` });
        } else {
          // Single-select: set selection and auto-submit if only one question
          selections.clear();
          selections.add(optionIndex);
          pending.selections.set(questionIndex, selections);

          if (pending.questions.length === 1) {
            // Single question, single-select: auto-submit
            const success = await this.submitAskUserQuestionAnswer(requestId);
            await ctx.answerCallbackQuery({
              text: success ? 'Answer submitted!' : 'Failed to submit',
            });
          } else {
            // Multiple questions: update UI and wait for submit
            const messageId = pending.messageIds[questionIndex];
            if (messageId) {
              await this.updateQuestionMessage(
                messageId,
                requestId,
                question,
                questionIndex,
                questionIndex === pending.questions.length - 1,
                selections
              );
            }
            await ctx.answerCallbackQuery({ text: `Selected: ${question.options[optionIndex]?.label}` });
          }
        }
        return;
      }

      // Handle AskUserQuestion "Other" (custom text input)
      if (action === 'askq_other') {
        const [, requestId, questionIndexStr] = parts;
        const questionIndex = parseInt(questionIndexStr, 10);
        const pending = this.pendingQuestions.get(requestId);

        if (!pending) {
          await ctx.answerCallbackQuery({ text: 'Question expired or already answered' });
          return;
        }

        const questionName = pending.questions[questionIndex]?.header || `Question ${questionIndex + 1}`;

        // Track that we're waiting for custom input for this specific question
        this.pendingCustomInput = { requestId, questionIndex };

        await ctx.answerCallbackQuery({
          text: `Type your answer for "${questionName}" as a message`,
          show_alert: true,
        });
        return;
      }

      // Handle AskUserQuestion submit
      if (action === 'askq_submit') {
        const [, requestId] = parts;
        console.log(`[Bot] Submit clicked for ${requestId}`);

        const pending = this.pendingQuestions.get(requestId);

        if (!pending) {
          console.log(`[Bot] No pending question found for ${requestId}`);
          await ctx.answerCallbackQuery({ text: 'Question expired or not found' });
          return;
        }

        // Check if at least one option is selected per question
        let allAnswered = true;
        let missingQuestion = -1;
        for (let i = 0; i < pending.questions.length; i++) {
          const selections = pending.selections.get(i);
          console.log(`[Bot] Q${i} selections: ${selections ? Array.from(selections).join(',') : 'none'}`);
          if (!selections || selections.size === 0) {
            allAnswered = false;
            missingQuestion = i;
            break;
          }
        }

        if (!allAnswered) {
          const qName = pending.questions[missingQuestion]?.header || `Question ${missingQuestion + 1}`;
          console.log(`[Bot] Missing selection for question ${missingQuestion}: ${qName}`);
          await ctx.answerCallbackQuery({
            text: `Please select an option for: ${qName}`,
            show_alert: true,
          });
          return;
        }

        const success = await this.submitAskUserQuestionAnswer(requestId);
        await ctx.answerCallbackQuery({
          text: success ? '✅ Answer submitted!' : '❌ Failed to submit',
        });
        return;
      }

      // Handle session option selection
      if (action === 'session_opt') {
        const [, sessionId, optionIndex] = parts;
        const session = this.sessionManager.getSession(sessionId);

        if (!session || !session.currentPrompt) {
          await ctx.answerCallbackQuery({ text: 'Session or prompt not found' });
          return;
        }

        // Get the input to send for this option
        const { OutputParser } = await import('../core/output-parser.js');
        const parser = new OutputParser();
        const input = parser.getInputForOption(session.currentPrompt, parseInt(optionIndex, 10));

        this.sessionManager.sendInput(sessionId, input);

        await ctx.editMessageText(
          `✅ Selected option ${optionIndex}`,
          { parse_mode: 'Markdown' }
        );
        await ctx.answerCallbackQuery({ text: 'Option selected!' });
        return;
      }

      // Handle "other" option (text input request)
      if (action === 'session_other') {
        const [, sessionId] = parts;
        await ctx.editMessageText(
          `✏️ Send your custom input using:\n\n\`/input <your text>\``,
          { parse_mode: 'Markdown' }
        );
        await ctx.answerCallbackQuery({ text: 'Use /input to send custom text' });
        return;
      }

      const requestId = parts[1];

      // Handle "allowall" action (from the button)
      if (action === 'allowall') {
        const request = this.pendingApprovals.get(requestId);

        // Enable auto-approve mode
        this.autoApproveMode = true;
        this.autoApproveStartTime = new Date();
        this.autoApproveCount = 0;

        // Approve current request if exists
        if (request) {
          request.resolve('allow');
          this.pendingApprovals.delete(requestId);
          this.autoApproveCount++;

          await ctx.editMessageText(
            `⚡ *Auto-Approve Mode ENABLED*\n\n` +
              `✅ Approved: \`${request.toolName}\`\n\n` +
              `All future requests will be auto-approved.\n` +
              `Send /stopallow to return to manual mode.`,
            { parse_mode: 'Markdown' }
          );
        }

        await ctx.answerCallbackQuery({ text: '⚡ Auto-approve enabled!' });
        console.log('Auto-approve mode enabled via button');
        return;
      }

      const request = this.pendingApprovals.get(requestId);
      if (!request) {
        await ctx.answerCallbackQuery({ text: 'Request expired or not found' });
        return;
      }

      const decision = action as 'allow' | 'deny';
      request.resolve(decision);
      this.pendingApprovals.delete(requestId);

      // Update the message to show the decision
      const emoji = decision === 'allow' ? '✅' : '❌';
      const text = decision === 'allow' ? 'Approved' : 'Denied';

      await ctx.editMessageText(
        `${emoji} *${text}*\n\n` +
          `Tool: \`${request.toolName}\`\n` +
          `Request ID: \`${request.id}\``,
        { parse_mode: 'Markdown' }
      );

      await ctx.answerCallbackQuery({ text: `${text}!` });
    });

    // Handle regular text messages - send to active session
    this.bot.on('message:text', async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      const text = ctx.message.text;

      // Ignore commands (they're handled by command handlers)
      if (text.startsWith('/')) {
        return;
      }

      // Check if there's pending custom folder path for spawn
      if (this.pendingSpawnCustomPath && this.pendingSpawn) {
        const { task, permissionMode, messageId } = this.pendingSpawn;
        this.pendingSpawn = null;
        this.pendingSpawnCustomPath = false;

        // Expand ~ to home directory
        const folderPath = expandPath(text.trim());

        // Validate path exists
        const fs = await import('fs');
        if (!fs.existsSync(folderPath)) {
          // Update original message
          if (this.chatId) {
            await this.bot.api.editMessageText(
              this.chatId,
              messageId,
              `❌ Directory does not exist: \`${folderPath}\`\n\nUse /spawn to try again.`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          }
          return;
        }

        if (!fs.statSync(folderPath).isDirectory()) {
          if (this.chatId) {
            await this.bot.api.editMessageText(
              this.chatId,
              messageId,
              `❌ Path is not a directory: \`${folderPath}\`\n\nUse /spawn to try again.`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          }
          return;
        }

        // Update the selection message
        if (this.chatId) {
          await this.bot.api.editMessageText(
            this.chatId,
            messageId,
            `📂 Selected: \`${shortenPath(folderPath)}\``,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }

        await this.executeSpawn(ctx, task, folderPath, permissionMode);
        return;
      }

      // Check if there's pending custom input for an AskUserQuestion
      if (this.pendingCustomInput) {
        const { requestId, questionIndex } = this.pendingCustomInput;
        const pending = this.pendingQuestions.get(requestId);

        if (pending) {
          const question = pending.questions[questionIndex];
          const questionName = question?.header || `Question ${questionIndex + 1}`;

          // Store the custom text as a special selection (-1 = custom)
          // We'll store the text separately
          if (!pending.customTexts) {
            (pending as any).customTexts = new Map<number, string>();
          }
          (pending as any).customTexts.set(questionIndex, text);

          // Mark as answered with a special indicator
          pending.selections.set(questionIndex, new Set([-1])); // -1 = custom

          this.pendingCustomInput = null;

          await ctx.reply(
            `✅ Custom answer for *${questionName}*: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"\n\n` +
              `Click *Submit All* when ready.`,
            { parse_mode: 'Markdown' }
          );
          return;
        } else {
          // Pending question expired
          this.pendingCustomInput = null;
        }
      }

      // AI interpretation layer - if available, let AI decide the action
      if (this.interpreter?.isAvailable()) {
        const chatId = ctx.chat?.id?.toString() || '';
        const context = this.buildInterpretationContext();
        const action = await this.interpreter.interpret(chatId, text, context);
        await this.handleAIAction(ctx, action, text);
        return;
      }

      // Legacy handling (no AI) - send text directly to active session
      await this.handleLegacyText(ctx, text);
    });
  }

  async start(): Promise<void> {
    console.log('Starting Telegram bot...');

    // Set up error handler to prevent crashes
    this.bot.catch((err) => {
      console.error('Telegram bot error:', err.message || err);
    });

    this.bot.start({
      onStart: (botInfo) => {
        console.log(`Telegram bot started: @${botInfo.username}`);
        console.log('Send /start to the bot to connect this chat.');
      },
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  getChatId(): string | null {
    return this.chatId;
  }

  setChatId(chatId: string): void {
    this.chatId = chatId;
  }

  /**
   * Send a warning message to Telegram (fire-and-forget).
   */
  async sendWarning(text: string): Promise<void> {
    if (!this.chatId) return;
    await this.bot.api.sendMessage(this.chatId, text, { parse_mode: 'Markdown' });
  }

  /**
   * Send an approval request to Telegram and wait for user decision.
   */
  async requestApproval(
    id: string,
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    cwd: string,
    escalationWarning?: string
  ): Promise<'allow' | 'deny'> {
    if (!this.chatId) {
      console.log('No chat ID configured. Defaulting to deny.');
      return 'deny';
    }

    // Format the tool input for display
    const inputDisplay = this.formatToolInput(toolName, toolInput);

    // Create inline keyboard with Approve/Deny/Allow All buttons
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `allow:${id}`)
      .text('❌ Deny', `deny:${id}`)
      .text('⚡ Allow All', `allowall:${id}`);

    // Build message with optional escalation warning
    let msgText =
      `\uD83D\uDD10 *Permission Request*\n\n` +
      `*Tool:* \`${toolName}\`\n` +
      `*Directory:* \`${cwd}\`\n\n`;

    if (escalationWarning) {
      msgText += `${escalationWarning}\n\n`;
    }

    msgText += `${inputDisplay}\n\n` + `_Request ID: ${id}_`;

    // Send the approval request message
    const message = await this.bot.api.sendMessage(
      this.chatId,
      msgText,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );

    // Create a promise that resolves when user clicks a button
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, {
        id,
        sessionId,
        toolName,
        toolInput,
        cwd,
        timestamp: new Date(),
        resolve,
      });

      // Set timeout (8 minutes warning, 10 minutes auto-deny)
      setTimeout(
        async () => {
          if (this.pendingApprovals.has(id)) {
            await this.bot.api.sendMessage(
              this.chatId!,
              `⚠️ *Timeout Warning*\n\nRequest \`${id}\` will auto-deny in 2 minutes if not answered.`,
              { parse_mode: 'Markdown' }
            );
          }
        },
        8 * 60 * 1000
      ); // 8 minutes

      setTimeout(
        () => {
          if (this.pendingApprovals.has(id)) {
            const req = this.pendingApprovals.get(id)!;
            this.pendingApprovals.delete(id);
            req.resolve('deny');
            this.bot.api
              .editMessageText(
                this.chatId!,
                message.message_id,
                `⏰ *Timed Out - Auto-Denied*\n\n` +
                  `Tool: \`${toolName}\`\n` +
                  `Request ID: \`${id}\``,
                { parse_mode: 'Markdown' }
              )
              .catch(() => {});
          }
        },
        10 * 60 * 1000
      ); // 10 minutes
    });
  }

  private formatToolInput(
    toolName: string,
    toolInput: Record<string, unknown>
  ): string {
    switch (toolName) {
      case 'Bash':
        return `\`\`\`\n${toolInput.command}\n\`\`\``;

      case 'Edit':
      case 'Write':
        const filePath = toolInput.file_path as string;
        return `*File:* \`${filePath}\``;

      case 'AskUserQuestion':
        const questions = toolInput.questions as Array<{
          question: string;
          options: Array<{ label: string }>;
        }>;
        if (questions && questions.length > 0) {
          const q = questions[0];
          const options = q.options?.map((o) => o.label).join(', ') || '';
          return `*Question:* ${q.question}\n*Options:* ${options}`;
        }
        return JSON.stringify(toolInput, null, 2);

      default:
        // Truncate long JSON and escape backticks to avoid markdown parsing issues
        let json = JSON.stringify(toolInput, null, 2);

        // Escape backticks to prevent markdown code block conflicts
        json = json.replace(/`/g, "'");

        if (json.length > 500) {
          return '```\n' + json.substring(0, 500) + '\n...(truncated)\n```';
        }
        return '```\n' + json + '\n```';
    }
  }
}
