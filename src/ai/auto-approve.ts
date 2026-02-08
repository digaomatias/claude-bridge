/**
 * Auto-Approve Rule Engine
 *
 * Evaluates tool use requests against configurable rules
 * to auto-allow or auto-deny without user interaction.
 */

import type { AutoApproveRule } from './types.js';
import type { HookPayload } from '../core/types.js';

/**
 * Default rules that ship with ClaudeBridge.
 * These cover common safe reads and dangerous operations.
 */
export function getDefaultRules(): AutoApproveRule[] {
  return [
    {
      name: 'safe-reads',
      match: {
        toolName: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      },
      action: 'allow',
      reason: 'Read-only operations are safe',
    },
    {
      name: 'deny-rm-rf',
      match: {
        toolName: 'Bash',
        commandPattern: 'rm\\s+(-[^\\s]*)?r[^\\s]*f|rm\\s+(-[^\\s]*)?f[^\\s]*r',
      },
      action: 'deny',
      reason: 'Recursive force delete is too dangerous to auto-approve',
    },
    {
      name: 'deny-force-push',
      match: {
        toolName: 'Bash',
        commandPattern: 'git\\s+push\\s+.*--force|git\\s+push\\s+-f',
      },
      action: 'deny',
      reason: 'Force push can destroy remote history',
    },
  ];
}

/**
 * Evaluate a hook payload against a list of auto-approve rules.
 * Returns the first matching rule, or null if no rules match.
 */
export function evaluateAutoApproveRules(
  payload: HookPayload,
  rules: AutoApproveRule[]
): AutoApproveRule | null {
  for (const rule of rules) {
    if (matchesRule(payload, rule)) {
      return rule;
    }
  }
  return null;
}

function matchesRule(payload: HookPayload, rule: AutoApproveRule): boolean {
  const { match } = rule;

  // Check tool name
  if (match.toolName) {
    const names = Array.isArray(match.toolName) ? match.toolName : [match.toolName];
    if (!names.includes(payload.tool_name)) {
      return false;
    }
  }

  // Check cwd pattern
  if (match.cwdPattern) {
    const regex = new RegExp(match.cwdPattern);
    if (!regex.test(payload.cwd)) {
      return false;
    }
  }

  // Check command pattern (for Bash tools)
  if (match.commandPattern) {
    const command = (payload.tool_input.command as string) || '';
    const regex = new RegExp(match.commandPattern);
    if (!regex.test(command)) {
      return false;
    }
  }

  // Check file pattern (for file-related tools)
  if (match.filePattern) {
    const filePath =
      (payload.tool_input.file_path as string) ||
      (payload.tool_input.path as string) ||
      '';
    const regex = new RegExp(match.filePattern);
    if (!regex.test(filePath)) {
      return false;
    }
  }

  return true;
}
