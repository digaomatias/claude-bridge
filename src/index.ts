/**
 * ClaudeBridge - AI-Controlled Claude Code Agent
 *
 * Main entry point - shows usage information.
 * Run `npm run server` to start the actual server.
 */

console.log(`
╔════════════════════════════════════════════════════════════╗
║                      ClaudeBridge                          ║
║         AI-Controlled Claude Code Agent                    ║
╚════════════════════════════════════════════════════════════╝

Development Status: Phase 1 - Telegram Approval Bridge

SETUP:

1. Create a Telegram bot via @BotFather:
   - Open Telegram and search for @BotFather
   - Send /newbot and follow the prompts
   - Copy the bot token

2. Set your bot token:
   export TELEGRAM_BOT_TOKEN="your-token-here"

3. Start the server:
   npm run server

4. In Telegram, send /start to your bot to connect

5. Claude Code permission requests will now appear in Telegram!

COMMANDS:

  npm run server      Start the main server (Telegram + hooks)
  npm run poc:server  Start POC server (manual stdin approval)
  npm run poc:test    Test hook communication

For full documentation, see README.md
`);
