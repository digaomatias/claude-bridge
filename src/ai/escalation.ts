/**
 * Escalation Classifier
 *
 * Pattern-based classification of tool use operations into
 * escalation levels: safe, caution, dangerous, critical.
 * Used to warn users even when auto-approve is enabled.
 */

import type { EscalationLevel, EscalationResult } from './types.js';
import type { HookPayload } from '../core/types.js';

interface EscalationPattern {
  level: EscalationLevel;
  toolName?: string;
  pattern: RegExp;
  description: string;
}

const ESCALATION_PATTERNS: EscalationPattern[] = [
  // Critical - operations that can cause irreversible data loss
  {
    level: 'critical',
    toolName: 'Bash',
    pattern: /rm\s+(-[^\s]*)?r[^\s]*f\s+\/\s|rm\s+(-[^\s]*)?f[^\s]*r\s+\/\s/,
    description: 'Recursive force delete from root',
  },
  {
    level: 'critical',
    toolName: 'Bash',
    pattern: /mkfs\./,
    description: 'Filesystem formatting',
  },
  {
    level: 'critical',
    toolName: 'Bash',
    pattern: /dd\s+.*of=\/dev\//,
    description: 'Direct disk write',
  },

  // Dangerous - operations with significant risk
  {
    level: 'dangerous',
    toolName: 'Bash',
    pattern: /git\s+push\s+.*--force|git\s+push\s+-f/,
    description: 'Force push',
  },
  {
    level: 'dangerous',
    toolName: 'Bash',
    pattern: /git\s+reset\s+--hard/,
    description: 'Hard reset',
  },
  {
    level: 'dangerous',
    toolName: 'Bash',
    pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i,
    description: 'SQL DROP operation',
  },
  {
    level: 'dangerous',
    toolName: 'Bash',
    pattern: /TRUNCATE\s+TABLE/i,
    description: 'SQL TRUNCATE operation',
  },
  {
    level: 'dangerous',
    toolName: 'Bash',
    pattern: /DELETE\s+FROM\s+\w+\s*(;|$)/i,
    description: 'SQL DELETE without WHERE clause',
  },
  {
    level: 'dangerous',
    toolName: 'Bash',
    pattern: /rm\s+(-[^\s]*)?r/,
    description: 'Recursive delete',
  },

  // Caution - operations that modify state and deserve attention
  {
    level: 'caution',
    toolName: 'Bash',
    pattern: /git\s+checkout\s+\./,
    description: 'Discard all local changes',
  },
  {
    level: 'caution',
    toolName: 'Bash',
    pattern: /git\s+clean\s+-[^\s]*f/,
    description: 'Force clean untracked files',
  },
  {
    level: 'caution',
    toolName: 'Bash',
    pattern: /chmod\s+/,
    description: 'Permission change',
  },
  {
    level: 'caution',
    toolName: 'Bash',
    pattern: /chown\s+/,
    description: 'Ownership change',
  },
  {
    level: 'caution',
    toolName: 'Bash',
    pattern: /npm\s+publish|yarn\s+publish/,
    description: 'Package publish',
  },
  {
    level: 'caution',
    toolName: 'Bash',
    pattern: /curl\s+.*\|\s*(ba)?sh/,
    description: 'Piping remote script to shell',
  },
];

/**
 * Classify a hook payload for escalation level.
 */
export function classifyEscalation(payload: HookPayload): EscalationResult {
  const matchedPatterns: string[] = [];
  let highestLevel: EscalationLevel = 'safe';

  const levelOrder: Record<EscalationLevel, number> = {
    safe: 0,
    caution: 1,
    dangerous: 2,
    critical: 3,
  };

  for (const ep of ESCALATION_PATTERNS) {
    // Skip if tool name doesn't match
    if (ep.toolName && ep.toolName !== payload.tool_name) {
      continue;
    }

    // Get the text to check against
    const textToCheck = getCheckableText(payload);
    if (!textToCheck) continue;

    if (ep.pattern.test(textToCheck)) {
      matchedPatterns.push(ep.description);
      if (levelOrder[ep.level] > levelOrder[highestLevel]) {
        highestLevel = ep.level;
      }
    }
  }

  return {
    level: highestLevel,
    reason: matchedPatterns.length > 0
      ? matchedPatterns.join(', ')
      : 'No escalation patterns matched',
    patterns: matchedPatterns,
  };
}

/**
 * Format an escalation warning for display in Telegram.
 */
export function formatEscalationWarning(result: EscalationResult): string {
  const icons: Record<EscalationLevel, string> = {
    safe: '',
    caution: '\u26A0\uFE0F',
    dangerous: '\u26A0\uFE0F\u26A0\uFE0F',
    critical: '\uD83D\uDED1',
  };

  const labels: Record<EscalationLevel, string> = {
    safe: '',
    caution: 'Caution',
    dangerous: 'DANGEROUS',
    critical: 'CRITICAL',
  };

  return `${icons[result.level]} *${labels[result.level]}*: ${result.reason}`;
}

function getCheckableText(payload: HookPayload): string | null {
  switch (payload.tool_name) {
    case 'Bash':
      return (payload.tool_input.command as string) || null;
    case 'Edit':
    case 'Write':
    case 'Read':
      return (payload.tool_input.file_path as string) || null;
    default:
      return JSON.stringify(payload.tool_input);
  }
}
