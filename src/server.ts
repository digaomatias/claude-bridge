/**
 * ClaudeBridge Server
 *
 * Main server that combines:
 * - Hook receiver (Fastify HTTP server)
 * - Telegram bot (grammY)
 *
 * Routes Claude Code permission requests to Telegram for approval.
 */

import Fastify from 'fastify';
import { TelegramBot } from './telegram/bot.js';
import { loadConfig, saveConfig, getConfigPath, logger } from './core/config.js';
import {
  HookPayload,
  PostToolHookPayload,
  HookResponse,
  AskUserQuestionInput,
} from './core/types.js';

// Rolling buffer for console output (for /status command)
const consoleBuffer: string[] = [];
const MAX_CONSOLE_LINES = 50;

function logToBuffer(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${message}`;
  consoleBuffer.push(line);
  if (consoleBuffer.length > MAX_CONSOLE_LINES) {
    consoleBuffer.shift();
  }
  console.log(message);
}

async function main() {
  const config = loadConfig();

  // Validate configuration
  if (!config.telegramBotToken) {
    console.error(`
╔════════════════════════════════════════════════════════════╗
║                   Configuration Required                    ║
╠════════════════════════════════════════════════════════════╣
║  TELEGRAM_BOT_TOKEN is not set.                            ║
║                                                            ║
║  1. Create a bot via @BotFather on Telegram                ║
║  2. Set the token:                                         ║
║                                                            ║
║     export TELEGRAM_BOT_TOKEN="your-token-here"            ║
║                                                            ║
║  Or create ${getConfigPath()}:
║                                                            ║
║     {                                                      ║
║       "telegramBotToken": "your-token-here"                ║
║     }                                                      ║
╚════════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }

  // Initialize Telegram bot with persistence callback and console output getter
  const bot = new TelegramBot(
    config.telegramBotToken,
    (chatId) => {
      // Save chat ID to config when it changes
      saveConfig({ telegramChatId: chatId });
    },
    () => consoleBuffer.slice(), // Return copy of buffer
    () => process.cwd() // Default working directory for sessions
  );

  // Restore saved chat ID if available
  if (config.telegramChatId) {
    bot.setChatId(config.telegramChatId);
    console.log(`Restored chat ID: ${config.telegramChatId}`);
  }

  // Start the bot
  await bot.start();

  // Create Fastify server
  const app = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  // Health check
  app.get('/health', async () => {
    return {
      status: 'ok',
      chatId: bot.getChatId(),
      configured: !!bot.getChatId(),
    };
  });

  // Tools that are safe to auto-allow (not destructive)
  // Note: AskUserQuestion is handled specially - we intercept it to build proper Telegram UI
  const AUTO_ALLOW_TOOLS = [
    'Read',             // Reading files is safe
    'Glob',             // Searching files is safe
    'Grep',             // Searching content is safe
    'WebSearch',        // Web searches are safe
    'WebFetch',         // Fetching web content is safe
  ];

  // Permission request hook
  let requestCounter = 0;
  app.post<{ Body: HookPayload }>('/hook/permission', async (request) => {
    const id = `req-${++requestCounter}`;
    const payload = request.body;

    logToBuffer(`[${id}] Permission request: ${payload.tool_name}`);

    // Special handling for AskUserQuestion - intercept and send to Telegram
    if (payload.tool_name === 'AskUserQuestion') {
      logToBuffer(`[${id}] Intercepting AskUserQuestion for Telegram UI`);

      const input = payload.tool_input as unknown as AskUserQuestionInput;
      const questions = input?.questions || [];

      if (questions.length > 0 && bot.getChatId()) {
        // Store pending question and send to Telegram
        await bot.handleAskUserQuestion(id, questions, payload.cwd);
      }

      // Allow the tool to proceed - the TUI will appear but we'll answer via PTY
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'AskUserQuestion intercepted for Telegram',
        },
      };
    }

    // Auto-allow safe tools
    if (AUTO_ALLOW_TOOLS.includes(payload.tool_name)) {
      logToBuffer(`[${id}] Auto-allowing safe tool: ${payload.tool_name}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Auto-allowed safe tool',
        },
      };
    }

    // Check if auto-approve mode is enabled
    if (bot.isAutoApproveMode()) {
      bot.incrementAutoApproveCount();
      logToBuffer(`[${id}] ⚡ Auto-approved: ${payload.tool_name}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Auto-approved (Allow All mode)',
        },
      };
    }

    // Check if bot is connected
    if (!bot.getChatId()) {
      logToBuffer(`[${id}] No Telegram chat connected. Denying by default.`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'No Telegram chat connected',
        },
      };
    }

    try {
      // Send to Telegram and wait for response
      const decision = await bot.requestApproval(
        id,
        payload.session_id,
        payload.tool_name,
        payload.tool_input,
        payload.cwd
      );

      logToBuffer(`[${id}] Decision: ${decision}`);

      const response: HookResponse = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason:
            decision === 'allow' ? 'Approved via Telegram' : 'Denied via Telegram',
        },
      };

      return response;
    } catch (err) {
      console.error(`[${id}] Error:`, err);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Error processing request',
        },
      };
    }
  });

  // Pre-tool-use hook (optional, for filtering)
  app.post<{ Body: HookPayload }>('/hook/pretool', async (request) => {
    const payload = request.body;
    console.log(`[pretool] ${payload.tool_name}`);

    // For now, allow all pre-tool-use requests
    // This can be extended with auto-approve rules
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  });

  // Post-tool-use hook - track completed actions
  app.post<{ Body: PostToolHookPayload }>('/hook/post-tool', async (request) => {
    const payload = request.body;

    // Record the action with the bot (matched by cwd)
    bot.recordAction({
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
      cwd: payload.cwd,
      sessionId: payload.session_id,
      timestamp: new Date(),
      success: !payload.error,
      error: payload.error,
    });

    logToBuffer(`[post-tool] ${payload.tool_name} in ${payload.cwd}`);

    return { ok: true };
  });

  // Save chat ID endpoint (called when /start is used)
  app.post<{ Body: { chatId: string } }>('/config/chat-id', async (request) => {
    const { chatId } = request.body;
    saveConfig({ telegramChatId: chatId });
    return { success: true };
  });

  // Start the server
  try {
    await app.listen({ port: config.serverPort, host: config.serverHost });
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                    ClaudeBridge Server                      ║
╠════════════════════════════════════════════════════════════╣
║  HTTP Server: http://${config.serverHost}:${config.serverPort}                       ║
║  Telegram Bot: ${bot.getChatId() ? 'Connected (' + bot.getChatId() + ')' : 'Waiting for /start...'}
║                                                            ║
║  Telegram Commands:                                        ║
║    /status    - Show mode, pending requests, output        ║
║    /allowall  - Enable auto-approve mode                   ║
║    /stopallow - Disable auto-approve mode                  ║
║                                                            ║
║  Endpoints:                                                ║
║    POST /hook/permission  - Permission request hook        ║
║    POST /hook/post-tool   - Post-tool action tracking      ║
║    GET  /health           - Health check                   ║
╚════════════════════════════════════════════════════════════╝
`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    // Kill all PTY sessions
    bot.getSessionManager().killAll();
    await bot.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
