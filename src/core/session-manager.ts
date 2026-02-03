/**
 * Session Manager
 *
 * Manages PTY sessions for Claude Code instances.
 * Spawns claude processes, captures output, and allows input injection.
 */

import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { ParsedPrompt, OutputParser } from './output-parser.js';
import { logger } from './config.js';

export type PermissionMode = 'plan' | 'auto' | 'ask' | 'default';

export interface Session {
  id: string;
  pty: pty.IPty;
  buffer: string[];
  rawBuffer: string;  // Raw ANSI output for screenshots
  status: 'active' | 'waiting' | 'completed';
  cwd: string;
  task: string;
  createdAt: Date;
  currentPrompt?: ParsedPrompt;
  permissionMode: PermissionMode;  // Current permission mode for this session
  lastPromptTime?: number;  // Timestamp of last prompt emission (for debouncing)
}

const MAX_RAW_BUFFER_SIZE = 50000; // ~50KB of raw terminal output

export interface SessionEvents {
  output: (sessionId: string, data: string) => void;
  prompt: (sessionId: string, prompt: ParsedPrompt) => void;
  exit: (sessionId: string, code: number) => void;
}

const MAX_BUFFER_LINES = 100;
const DEFAULT_SHELL = process.env.SHELL || '/bin/zsh';

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private sessionCounter = 0;
  private outputParser: OutputParser;

  constructor() {
    super();
    this.outputParser = new OutputParser();
  }

  /**
   * Spawn a new Claude Code session
   */
  spawn(task: string, cwd: string, permissionMode: PermissionMode = 'default'): Session {
    const id = `session-${++this.sessionCounter}`;

    logger.info(`[SessionManager] Spawning session ${id} in ${cwd}`);
    logger.debug(`[SessionManager] Task: ${task}`);
    logger.debug(`[SessionManager] Permission mode: ${permissionMode}`);

    // Escape the task for shell
    const escapedTask = task.replace(/'/g, "'\\''");

    // Build claude command with permission mode flag if not default
    // Use -- to prevent task text from being interpreted as flags
    let claudeCmd = `claude -- '${escapedTask}'`;
    if (permissionMode === 'plan') {
      claudeCmd = `claude --permission-mode plan -- '${escapedTask}'`;
    } else if (permissionMode === 'auto') {
      claudeCmd = `claude --permission-mode bypassPermissions -- '${escapedTask}'`;
    } else if (permissionMode === 'ask') {
      claudeCmd = `claude --permission-mode default -- '${escapedTask}'`;
    }

    // Spawn via shell so PATH is resolved correctly
    const ptyProcess = pty.spawn(DEFAULT_SHELL, ['-l', '-c', claudeCmd], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
      },
    });

    const session: Session = {
      id,
      pty: ptyProcess,
      buffer: [],
      rawBuffer: '',
      status: 'active',
      cwd,
      task,
      createdAt: new Date(),
      permissionMode,
    };

    // Handle output from PTY
    ptyProcess.onData((data: string) => {
      this.handleOutput(session, data);
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[SessionManager] Session ${id} exited with code ${exitCode}`);
      session.status = 'completed';
      this.emit('exit', id, exitCode);
    });

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Handle output from a session
   */
  private handleOutput(session: Session, data: string) {
    // Add to rolling buffer (cleaned lines)
    const lines = data.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        session.buffer.push(line);
        if (session.buffer.length > MAX_BUFFER_LINES) {
          session.buffer.shift();
        }
      }
    }

    // Store raw ANSI output for screenshots
    session.rawBuffer += data;
    if (session.rawBuffer.length > MAX_RAW_BUFFER_SIZE) {
      // Keep the last portion
      session.rawBuffer = session.rawBuffer.slice(-MAX_RAW_BUFFER_SIZE);
    }

    // Emit raw output event
    this.emit('output', session.id, data);

    // Check for prompts/questions (with debouncing)
    const prompt = this.outputParser.parse(data);
    if (prompt) {
      const now = Date.now();
      const timeSinceLastPrompt = session.lastPromptTime ? now - session.lastPromptTime : Infinity;

      // Debounce: only emit if >2 seconds since last prompt OR different prompt type
      const isDifferentPrompt = !session.currentPrompt || session.currentPrompt.type !== prompt.type;
      const isDebounceExpired = timeSinceLastPrompt > 2000;

      if (isDifferentPrompt || isDebounceExpired) {
        session.status = 'waiting';
        session.currentPrompt = prompt;
        session.lastPromptTime = now;
        console.log(`[SessionManager] Detected prompt in session ${session.id}:`, prompt.type);
        this.emit('prompt', session.id, prompt);
      } else {
        // Update the prompt but don't emit (debounced)
        session.currentPrompt = prompt;
      }
    }
  }

  /**
   * Send input to a session
   */
  sendInput(sessionId: string, input: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[SessionManager] Session ${sessionId} not found`);
      return false;
    }

    if (session.status === 'completed') {
      console.error(`[SessionManager] Session ${sessionId} has already completed`);
      return false;
    }

    // Escape control characters for readable logging
    const readableInput = input
      .replace(/\x1b\[A/g, '↑')
      .replace(/\x1b\[B/g, '↓')
      .replace(/\x1b\[C/g, '→')
      .replace(/\x1b\[D/g, '←')
      .replace(/\r/g, '⏎')
      .replace(/\n/g, '↵')
      .replace(/\t/g, '⇥')
      .replace(/ /g, '␣');
    logger.debug(`[SessionManager] Sending input to ${sessionId}: ${readableInput}`);
    session.pty.write(input);
    session.status = 'active';
    session.currentPrompt = undefined;
    return true;
  }

  /**
   * Send a key press (like Enter, arrow keys, etc.)
   */
  sendKey(sessionId: string, key: string): boolean {
    return this.sendInput(sessionId, key);
  }

  /**
   * Get recent output from a session
   */
  getContext(sessionId: string, lines = 20): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }
    return session.buffer.slice(-lines);
  }

  /**
   * Get raw ANSI output for screenshots
   */
  getRawOutput(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return '';
    }
    return session.rawBuffer;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update permission mode for a session
   */
  setPermissionMode(sessionId: string, mode: PermissionMode): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.permissionMode = mode;
    return true;
  }

  /**
   * Find session by working directory
   */
  findSessionByCwd(cwd: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.cwd === cwd && session.status !== 'completed') {
        return session;
      }
    }
    return undefined;
  }

  /**
   * List all sessions
   */
  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get active sessions only
   */
  getActiveSessions(): Session[] {
    return this.listSessions().filter((s) => s.status !== 'completed');
  }

  /**
   * Kill a session
   */
  kill(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    console.log(`[SessionManager] Killing session ${sessionId}`);
    session.pty.kill();
    session.status = 'completed';
    return true;
  }

  /**
   * Kill all sessions
   */
  killAll(): void {
    for (const session of this.sessions.values()) {
      if (session.status !== 'completed') {
        session.pty.kill();
        session.status = 'completed';
      }
    }
  }

  /**
   * Remove completed sessions from memory
   */
  cleanup(): number {
    let removed = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (session.status === 'completed') {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
