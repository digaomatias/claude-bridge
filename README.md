# ClaudeBridge

AI-Controlled Claude Code Agent via Telegram.

## Overview

ClaudeBridge is a Telegram-controlled agent where a **Front-end AI** (user's choice of model with their API key) orchestrates **Claude Code** sessions. The Front-end AI interprets user requests, spawns Claude Code tasks, handles approvals, and can fetch context on demand.

## Architecture

```
User (Telegram) → Front-end AI → Claude Code Session
                      ↑                    ↓
                      └──── Hook Bridge ───┘
```

## Current Status: Phase 1 - Telegram Approval Bridge

Permission requests from Claude Code are forwarded to Telegram with Approve/Deny buttons.

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the bot token you receive

### 2. Install & Configure

```bash
cd ~/source/claude-bridge
npm install

# Set your bot token
export TELEGRAM_BOT_TOKEN="your-token-here"
```

### 3. Start the Server

```bash
npm run server
```

### 4. Connect Telegram

1. Open your bot in Telegram
2. Send `/start` to connect
3. You'll see confirmation that the chat is connected

### 5. Configure Claude Code Hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3847/hook/permission -H 'Content-Type: application/json' -d @-"
          }
        ]
      }
    ]
  }
}
```

### 6. Test It!

1. Start Claude Code in any project
2. Ask Claude to do something requiring permission
3. Check Telegram - you'll see the request with Approve/Deny buttons
4. Tap a button - Claude Code will proceed accordingly

## Commands

### NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run server` | Start the main server (Telegram + hooks) |
| `npm run dev` | Start with auto-reload (development) |
| `npm run poc:server` | POC server (manual stdin approval) |
| `npm run poc:test` | Test hook communication |

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Connect this chat to ClaudeBridge |
| `/status` | Show pending approval requests |
| `/help` | Show help |

## Configuration

Configuration can be set via environment variables or `~/.claude-bridge/config.json`:

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | (required) |
| `TELEGRAM_CHAT_ID` | Pre-configured chat ID | (from /start) |
| `PORT` | Server port | 3847 |
| `HOST` | Server host | 127.0.0.1 |

## Development Phases

- [x] Phase 0: POC - Hook bidirectional communication
- [x] Phase 1: Basic Approval Bridge (Telegram integration)
- [ ] Phase 2: Front-end AI Integration
- [ ] Phase 3: Session Management
- [ ] Phase 4: Polish & Robustness

## Project Structure

```
claude-bridge/
├── src/
│   ├── index.ts           # Usage information
│   ├── server.ts          # Main server (Phase 1+)
│   ├── core/
│   │   └── config.ts      # Configuration management
│   ├── telegram/
│   │   └── bot.ts         # Telegram bot (grammY)
│   ├── poc/               # Phase 0 POC code
│   │   ├── hook-server.ts
│   │   └── test-hook.ts
│   └── hooks/             # Hook handling (future)
├── hooks/
│   └── claude-hooks.json  # Example hook config
├── .env.example           # Environment template
├── package.json
├── tsconfig.json
└── README.md
```

## Timeout Handling

- Permission requests timeout after **10 minutes** (Claude Code default)
- At **8 minutes**, you'll receive a warning in Telegram
- If not answered by **10 minutes**, the request is auto-denied

## License

MIT
