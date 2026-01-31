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
import { loadConfig, saveConfig, getConfigPath } from './core/config.js';

interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookResponse {
  decision: 'allow' | 'deny';
  reason?: string;
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

  // Initialize Telegram bot
  const bot = new TelegramBot(config.telegramBotToken);

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
  const AUTO_ALLOW_TOOLS = [
    'AskUserQuestion',  // Just asking questions, not taking actions
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

    console.log(`\n[${id}] Permission request: ${payload.tool_name}`);

    // Auto-allow safe tools
    if (AUTO_ALLOW_TOOLS.includes(payload.tool_name)) {
      console.log(`[${id}] Auto-allowing safe tool: ${payload.tool_name}`);
      return { decision: 'allow', reason: 'Auto-allowed safe tool' };
    }

    // Check if bot is connected
    if (!bot.getChatId()) {
      console.log(`[${id}] No Telegram chat connected. Denying by default.`);
      return { decision: 'deny', reason: 'No Telegram chat connected' };
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

      console.log(`[${id}] Decision: ${decision}`);

      const response: HookResponse = {
        decision,
        reason: decision === 'allow' ? 'Approved via Telegram' : 'Denied via Telegram',
      };

      return response;
    } catch (err) {
      console.error(`[${id}] Error:`, err);
      return { decision: 'deny', reason: 'Error processing request' };
    }
  });

  // Pre-tool-use hook (optional, for filtering)
  app.post<{ Body: HookPayload }>('/hook/pretool', async (request) => {
    const payload = request.body;
    console.log(`[pretool] ${payload.tool_name}`);

    // For now, allow all pre-tool-use requests
    // This can be extended with auto-approve rules
    return { decision: 'allow' };
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
║  Endpoints:                                                ║
║    POST /hook/permission  - Claude Code permission hook    ║
║    POST /hook/pretool     - Pre-tool-use hook              ║
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
