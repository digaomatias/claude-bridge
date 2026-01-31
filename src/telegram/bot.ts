/**
 * Telegram Bot Module
 *
 * Handles Telegram interactions using grammY.
 * Sends approval requests and receives user decisions.
 */

import { Bot, InlineKeyboard, Context } from 'grammy';

// Callback for when chat ID changes (for persistence)
type ChatIdCallback = (chatId: string) => void;

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  timestamp: Date;
  resolve: (decision: 'allow' | 'deny') => void;
}

export class TelegramBot {
  private bot: Bot;
  private chatId: string | null = null;
  private pendingApprovals = new Map<string, ApprovalRequest>();
  private onChatIdChange: ChatIdCallback | null = null;

  constructor(token: string, onChatIdChange?: ChatIdCallback) {
    this.bot = new Bot(token);
    this.onChatIdChange = onChatIdChange || null;
    this.setupHandlers();
  }

  private setupHandlers() {
    // /start command - register chat ID
    this.bot.command('start', async (ctx) => {
      this.chatId = ctx.chat.id.toString();

      // Persist the chat ID
      if (this.onChatIdChange) {
        this.onChatIdChange(this.chatId);
      }

      await ctx.reply(
        `🤖 *ClaudeBridge Connected*\n\n` +
          `Chat ID: \`${this.chatId}\`\n\n` +
          `You'll receive approval requests here when Claude Code needs permission.\n\n` +
          `Commands:\n` +
          `/status - Show pending approvals\n` +
          `/help - Show help`,
        { parse_mode: 'Markdown' }
      );
      console.log(`Telegram connected. Chat ID: ${this.chatId}`);
    });

    // /status command
    this.bot.command('status', async (ctx) => {
      if (this.pendingApprovals.size === 0) {
        await ctx.reply('✅ No pending approval requests.');
      } else {
        const list = Array.from(this.pendingApprovals.values())
          .map((req) => `• \`${req.id}\`: ${req.toolName}`)
          .join('\n');
        await ctx.reply(`⏳ *Pending Approvals:*\n\n${list}`, {
          parse_mode: 'Markdown',
        });
      }
    });

    // /help command
    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        `🤖 *ClaudeBridge Help*\n\n` +
          `This bot forwards approval requests from Claude Code.\n\n` +
          `*Commands:*\n` +
          `/start - Connect this chat\n` +
          `/status - Show pending approvals\n` +
          `/help - Show this help\n\n` +
          `When Claude Code needs permission, you'll see a message with Approve/Deny buttons.`,
        { parse_mode: 'Markdown' }
      );
    });

    // Handle callback queries (button presses)
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const [action, requestId] = data.split(':');

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
  }

  async start(): Promise<void> {
    console.log('Starting Telegram bot...');
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
   * Send an approval request to Telegram and wait for user decision.
   */
  async requestApproval(
    id: string,
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    cwd: string
  ): Promise<'allow' | 'deny'> {
    if (!this.chatId) {
      console.log('No chat ID configured. Defaulting to deny.');
      return 'deny';
    }

    // Format the tool input for display
    const inputDisplay = this.formatToolInput(toolName, toolInput);

    // Create inline keyboard with Approve/Deny buttons
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `allow:${id}`)
      .text('❌ Deny', `deny:${id}`);

    // Send the approval request message
    const message = await this.bot.api.sendMessage(
      this.chatId,
      `🔐 *Permission Request*\n\n` +
        `*Tool:* \`${toolName}\`\n` +
        `*Directory:* \`${cwd}\`\n\n` +
        `${inputDisplay}\n\n` +
        `_Request ID: ${id}_`,
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
        // Truncate long JSON
        const json = JSON.stringify(toolInput, null, 2);
        if (json.length > 500) {
          return '```\n' + json.substring(0, 500) + '\n...(truncated)\n```';
        }
        return '```\n' + json + '\n```';
    }
  }
}
