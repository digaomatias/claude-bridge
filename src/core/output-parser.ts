/**
 * Output Parser
 *
 * Parses Claude Code terminal output to detect:
 * - Multi-option questions (AskUserQuestion)
 * - Permission prompts
 * - Yes/No confirmations
 * - Completion status
 */

export type PromptType = 'multi_option' | 'permission' | 'yes_no' | 'text_input' | 'completion';

export interface ParsedPrompt {
  type: PromptType;
  question?: string;
  options?: PromptOption[];
  raw: string;
}

export interface PromptOption {
  index: number;
  label: string;
  description?: string;
  isSelected?: boolean;
}

// ANSI escape code regex for stripping colors
const ANSI_REGEX = /\x1B\[[0-9;]*[a-zA-Z]/g;

export class OutputParser {
  /**
   * Strip ANSI escape codes from text
   */
  private stripAnsi(text: string): string {
    return text.replace(ANSI_REGEX, '');
  }

  /**
   * Parse terminal output and detect prompts
   */
  parse(data: string): ParsedPrompt | null {
    const cleaned = this.stripAnsi(data);

    // Check for multi-option questions first (most specific)
    const multiOption = this.parseMultiOption(cleaned, data);
    if (multiOption) return multiOption;

    // Check for yes/no prompts
    const yesNo = this.parseYesNo(cleaned, data);
    if (yesNo) return yesNo;

    // Check for permission prompts
    const permission = this.parsePermission(cleaned, data);
    if (permission) return permission;

    // Check for task completion
    const completion = this.parseCompletion(cleaned, data);
    if (completion) return completion;

    return null;
  }

  /**
   * Parse multi-option questions (e.g., from AskUserQuestion)
   *
   * Claude Code prompts have this structure:
   * "Would you like to proceed?
   *  ❯ 1. Option A
   *    2. Option B
   *    3. Option C"
   *
   * Key insight: The prompt is at the END of the output, and options
   * are marked with ❯ (arrow) for the selected one. We need to find
   * the prompt section and ignore plan content above it.
   */
  private parseMultiOption(cleaned: string, raw: string): ParsedPrompt | null {
    const lines = cleaned.split('\n');

    // Find the prompt by looking for the ❯ indicator (marks selected option)
    // Search backwards from the end since prompts appear at the bottom
    let promptStartIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      // Look for arrow indicator or numbered option with arrow
      if (line.includes('❯') || line.includes('►')) {
        promptStartIndex = i;
        break;
      }
    }

    // If no arrow found, look for question patterns followed by numbered options
    if (promptStartIndex === -1) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        // Look for lines ending with ? that might be questions
        if (line.endsWith('?') && i < lines.length - 1) {
          // Check if next non-empty line looks like an option
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j].trim();
            if (nextLine && /^[❯►]?\s*\d+[.)]\s*.+/.test(nextLine)) {
              promptStartIndex = j;
              break;
            }
          }
          if (promptStartIndex !== -1) break;
        }
      }
    }

    if (promptStartIndex === -1) {
      return null;
    }

    // Find the question line (look backwards from the first option)
    let questionLine = '';
    for (let i = promptStartIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line && line.endsWith('?')) {
        questionLine = line;
        break;
      }
      // Stop if we hit a separator or empty line
      if (!line || line.match(/^[-=─━]+$/)) {
        break;
      }
    }

    // Parse options starting from promptStartIndex
    const options: PromptOption[] = [];
    const numberedWithArrowPattern = /^[❯►]?\s*(\d+)[.)]\s*(.+)$/;
    const radioPattern = /^[○●□■◉◎]\s*(.+)$/;

    for (let i = promptStartIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Stop if we hit footer hints like "Enter to select"
      if (line.startsWith('Enter to') || line.startsWith('ctrl-') || line.startsWith('Tab/')) {
        break;
      }

      // Try numbered pattern (with optional arrow)
      let match = line.match(numberedWithArrowPattern);
      if (match) {
        const isSelected = line.includes('❯') || line.includes('►');
        options.push({
          index: parseInt(match[1], 10),
          label: match[2].trim(),
          isSelected,
        });
        continue;
      }

      // Try radio/checkbox pattern
      match = line.match(radioPattern);
      if (match) {
        const isSelected = line.startsWith('●') || line.startsWith('■') || line.startsWith('◉');
        options.push({
          index: options.length + 1,
          label: match[1].trim(),
          isSelected,
        });
        continue;
      }

      // If line doesn't match option patterns and we already have options, stop
      if (options.length > 0 && !line.match(/^\d+[.)]/)) {
        break;
      }
    }

    // Need at least 2 options to be a valid prompt
    if (options.length >= 2) {
      return {
        type: 'multi_option',
        question: questionLine || undefined,
        options,
        raw,
      };
    }

    return null;
  }

  /**
   * Parse yes/no prompts
   *
   * Patterns:
   * "Do you want to proceed? (y/n)"
   * "Continue? [Y/n]"
   * "Are you sure? (yes/no)"
   */
  private parseYesNo(cleaned: string, raw: string): ParsedPrompt | null {
    const patterns = [
      /\(y\/n\)/i,
      /\[y\/n\]/i,
      /\(yes\/no\)/i,
      /\[yes\/no\]/i,
      /\(Y\/n\)/,
      /\[Y\/n\]/,
      /\(y\/N\)/,
      /\[y\/N\]/,
    ];

    for (const pattern of patterns) {
      if (pattern.test(cleaned)) {
        // Extract the question (everything before the pattern)
        const match = cleaned.match(/(.+?)(\s*\(|\s*\[)/);
        const question = match ? match[1].trim() : cleaned;

        return {
          type: 'yes_no',
          question,
          options: [
            { index: 1, label: 'Yes' },
            { index: 2, label: 'No' },
          ],
          raw,
        };
      }
    }

    return null;
  }

  /**
   * Parse permission prompts from Claude Code
   *
   * Patterns:
   * "Allow Claude to..."
   * "Do you want to allow..."
   * "Permission needed to..."
   */
  private parsePermission(cleaned: string, raw: string): ParsedPrompt | null {
    const patterns = [
      /Allow\s+(Claude|claude|this tool)\s+to\s+(.+?)\?/i,
      /Do you want to allow\s+(.+?)\?/i,
      /Permission\s+(needed|required)\s+to\s+(.+)/i,
      /May\s+I\s+(.+?)\?/i,
    ];

    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match) {
        return {
          type: 'permission',
          question: match[0],
          options: [
            { index: 1, label: 'Allow' },
            { index: 2, label: 'Deny' },
          ],
          raw,
        };
      }
    }

    return null;
  }

  /**
   * Parse completion indicators
   *
   * Patterns:
   * "✓ Task completed"
   * "Done!"
   * "Finished"
   */
  private parseCompletion(cleaned: string, raw: string): ParsedPrompt | null {
    const patterns = [
      /[✓✔]\s*(Task\s+)?(completed|done|finished)/i,
      /^Done!?$/im,
      /^Finished!?$/im,
      /^Complete!?$/im,
      /successfully\s+(completed|finished)/i,
    ];

    for (const pattern of patterns) {
      if (pattern.test(cleaned)) {
        return {
          type: 'completion',
          raw,
        };
      }
    }

    return null;
  }

  /**
   * Get the key to send for a given option index
   * Handles different prompt types appropriately
   *
   * Claude Code TUI behavior:
   * - Multi-option: pressing a number key selects that option AND auto-advances
   *   to the next tab/question. No Enter key needed.
   * - Yes/No: send 'y' or 'n' followed by Enter
   * - Permission: same as Yes/No
   */
  getInputForOption(prompt: ParsedPrompt, optionIndex: number): string {
    switch (prompt.type) {
      case 'multi_option':
        // Just send the number - TUI auto-selects and advances
        // No Enter needed! The number key does everything.
        return `${optionIndex}`;

      case 'yes_no':
        return optionIndex === 1 ? 'y\r' : 'n\r';

      case 'permission':
        return optionIndex === 1 ? 'y\r' : 'n\r';

      default:
        return '\r';
    }
  }
}
