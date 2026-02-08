/**
 * AI Tool Definitions
 *
 * Factory function that creates observation tools (auto-executed by SDK)
 * and action tools (stop the agent loop, returned to caller).
 *
 * Observation tools have an `execute` function — the SDK runs them
 * automatically and feeds results back to the model.
 * Action tools have no `execute` — when the model picks one,
 * the loop stops and the tool call is returned to the caller.
 */

import { z } from 'zod';
import { tool } from 'ai';
import type { ObservationCallbacks, InterpretationContext } from './types.js';

/** Key name → ANSI escape sequence map (matches bot.ts /keys command). */
const KEY_MAP: Record<string, string> = {
  'down': '\x1b[B',
  'up': '\x1b[A',
  'left': '\x1b[D',
  'right': '\x1b[C',
  'enter': '\r',
  'return': '\r',
  'tab': '\t',
  'shift+tab': '\x1b[Z',
  'shifttab': '\x1b[Z',
  'space': ' ',
  'esc': '\x1b',
  'escape': '\x1b',
  'ctrl+c': '\x03',
  'ctrlc': '\x03',
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
};

/**
 * Create the full tool set for the AI interpreter.
 *
 * @param callbacks  Functions to read terminal output, send keys, list sessions
 * @param context    Current interpretation context (provides activeSessionId)
 */
export function createAITools(callbacks: ObservationCallbacks, context: InterpretationContext) {
  return {
    // ─── Observation tools (have execute → SDK auto-runs them) ───

    get_terminal_output: tool({
      description:
        'Read the current terminal output from the active session. ' +
        'Use when the user asks what\'s happening, what\'s on screen, or you need to see output before responding.',
      inputSchema: z.object({
        lines: z
          .number()
          .optional()
          .describe('Number of lines to read (default 50).'),
      }),
      execute: async ({ lines }) => {
        if (!context.activeSessionId) {
          return 'No active session.';
        }
        const output = callbacks.getTerminalOutput(context.activeSessionId, lines ?? 50);
        if (!output || output.length === 0) {
          return 'Session has no output yet.';
        }
        return output.slice(0, 3500);
      },
    }),

    send_keys: tool({
      description:
        'Send keystrokes to the active session (e.g. arrow keys, enter, tab, escape). ' +
        'After sending keys, follow up with get_terminal_output to see the result.',
      inputSchema: z.object({
        keys: z
          .array(z.string())
          .describe(
            'Key names to send in order. Supported: down, up, left, right, enter, tab, shift+tab, space, esc, ctrl+c, 0-9.'
          ),
      }),
      execute: async ({ keys }) => {
        if (!context.activeSessionId) {
          return 'No active session to send keys to.';
        }
        const sequence = keys
          .map(k => KEY_MAP[k.toLowerCase()] ?? '')
          .filter(k => k.length > 0)
          .join('');
        if (sequence.length === 0) {
          return 'No valid keys provided.';
        }
        const success = callbacks.sendKeys(context.activeSessionId, sequence);
        return success
          ? `Sent keys: ${keys.join(', ')}`
          : 'Failed to send keys to session.';
      },
    }),

    list_sessions: tool({
      description:
        'List all active Claude Code sessions with their status, task, and directory.',
      inputSchema: z.object({}),
      execute: async () => {
        const sessions = callbacks.listSessions();
        if (sessions.length === 0) {
          return 'No sessions running.';
        }
        return sessions
          .map(s => {
            const active = s.isActive ? ' [ACTIVE]' : '';
            return `${s.id}${active}: ${s.status} | ${s.task || 'no task'} | ${s.cwd} | ${s.ageMinutes}min`;
          })
          .join('\n');
      },
    }),

    // ─── Action tools (no execute → loop stops, returned to caller) ───

    spawn_session: tool({
      description:
        'Start a new Claude Code session with a task. Use when the user wants to begin new coding work.',
      inputSchema: z.object({
        task: z
          .string()
          .describe('A clear, refined task description for Claude Code to work on.'),
        cwd: z
          .string()
          .optional()
          .describe(
            'Working directory path (e.g. ~/source/myapp). If omitted, the user will be shown a folder picker.'
          ),
        permissionMode: z
          .enum(['default', 'plan', 'auto', 'ask'])
          .optional()
          .describe(
            'Permission mode for the session. default = normal, plan = plan only, auto = auto-approve, ask = always ask.'
          ),
      }),
    }),

    send_to_session: tool({
      description:
        'Forward text to the active Claude Code session. Use when the user is responding to or interacting with the running session.',
      inputSchema: z.object({
        text: z
          .string()
          .describe('The text to send to the active session.'),
      }),
    }),

    reply_directly: tool({
      description:
        'Reply to the user directly without involving Claude Code. Use for greetings, status questions, help, or meta-questions.',
      inputSchema: z.object({
        text: z
          .string()
          .describe('The reply text to send to the user.'),
      }),
    }),

    ask_clarification: tool({
      description:
        'Ask the user a clarifying question before deciding on an action. Use when intent is ambiguous.',
      inputSchema: z.object({
        question: z
          .string()
          .describe('The clarifying question to ask the user.'),
      }),
    }),
  };
}
