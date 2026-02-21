/**
 * Audit Logging
 *
 * Append-only JSON Lines audit log for security events.
 * Auto-rotates at 5MB, keeps 3 rotated files.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AuditEntry {
  timestamp: string;
  event: string;
  sessionId?: string;
  toolName?: string;
  toolInputSummary?: string;
  decision?: string;
  reason?: string;
  chatId?: string;
  ip?: string;
  details?: Record<string, unknown>;
}

const AUDIT_DIR = path.join(process.env.HOME || '~', '.claude-bridge');
const AUDIT_PATH = path.join(AUDIT_DIR, 'audit.log');
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ROTATED = 3;

export class AuditLogger {
  private fd: number | null = null;
  private currentSize = 0;

  constructor() {
    this.open();
  }

  private open(): void {
    try {
      if (!fs.existsSync(AUDIT_DIR)) {
        fs.mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
      }

      this.fd = fs.openSync(AUDIT_PATH, 'a', 0o600);
      // Ensure file permissions are correct even if file already existed
      fs.chmodSync(AUDIT_PATH, 0o600);

      try {
        const stat = fs.fstatSync(this.fd);
        this.currentSize = stat.size;
      } catch {
        this.currentSize = 0;
      }
    } catch (err) {
      console.error('[Audit] Failed to open audit log:', err);
      this.fd = null;
    }
  }

  log(entry: AuditEntry): void {
    if (this.fd === null) return;

    try {
      const line = JSON.stringify(entry) + '\n';
      const buf = Buffer.from(line, 'utf-8');
      fs.writeSync(this.fd, buf);
      this.currentSize += buf.length;

      if (this.currentSize >= MAX_SIZE) {
        this.rotate();
      }
    } catch (err) {
      console.error('[Audit] Failed to write audit entry:', err);
    }
  }

  private rotate(): void {
    try {
      // Close current fd
      if (this.fd !== null) {
        fs.closeSync(this.fd);
        this.fd = null;
      }

      // Shift existing rotated files
      for (let i = MAX_ROTATED; i >= 1; i--) {
        const older = `${AUDIT_PATH}.${i}`;
        const newer = i === 1 ? AUDIT_PATH : `${AUDIT_PATH}.${i - 1}`;
        if (i === MAX_ROTATED && fs.existsSync(older)) {
          fs.unlinkSync(older);
        }
        if (fs.existsSync(newer)) {
          fs.renameSync(newer, `${AUDIT_PATH}.${i}`);
        }
      }

      // Reopen fresh file
      this.open();
    } catch (err) {
      console.error('[Audit] Failed to rotate audit log:', err);
      // Try to reopen
      this.open();
    }
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
  }
}

/**
 * Summarize tool input for audit log (extract the key field).
 */
export function summarizeToolInput(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  switch (toolName) {
    case 'Bash':
      return truncate(String(toolInput.command || ''), 200);
    case 'Read':
    case 'Write':
    case 'Edit':
      return truncate(String(toolInput.file_path || ''), 200);
    case 'Glob':
    case 'Grep':
      return truncate(String(toolInput.pattern || ''), 200);
    case 'Task':
      return truncate(String(toolInput.prompt || ''), 200);
    default: {
      const json = JSON.stringify(toolInput);
      return truncate(json, 200);
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Log a permission decision event.
 */
export function auditPermission(
  logger: AuditLogger,
  event: string,
  opts: {
    sessionId?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    decision?: string;
    reason?: string;
    chatId?: string;
    ip?: string;
    details?: Record<string, unknown>;
  }
): void {
  logger.log({
    timestamp: new Date().toISOString(),
    event,
    sessionId: opts.sessionId,
    toolName: opts.toolName,
    toolInputSummary: opts.toolName && opts.toolInput
      ? summarizeToolInput(opts.toolName, opts.toolInput)
      : undefined,
    decision: opts.decision,
    reason: opts.reason,
    chatId: opts.chatId,
    ip: opts.ip,
    details: opts.details,
  });
}

/**
 * Log an authentication event.
 */
export function auditAuth(
  logger: AuditLogger,
  event: string,
  opts: {
    chatId?: string;
    ip?: string;
    details?: Record<string, unknown>;
  }
): void {
  logger.log({
    timestamp: new Date().toISOString(),
    event,
    chatId: opts.chatId,
    ip: opts.ip,
    details: opts.details,
  });
}
