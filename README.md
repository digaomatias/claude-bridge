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

### 2. Install

#### One-Line Remote Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/digaomatias/claude-bridge/main/install-remote.sh | bash
```

This will:
- Clone the repo to `~/.claude-bridge`
- Install dependencies and build
- Prompt for your Telegram bot token
- Configure Claude Code hooks automatically
- Create a `claude-bridge` launcher in `~/.local/bin`

After installation, start with:

```bash
claude-bridge
```

To update or uninstall later:

```bash
claude-bridge update
claude-bridge uninstall
```

#### Manual Install

```bash
git clone https://github.com/digaomatias/claude-bridge.git
cd claude-bridge
npm install

# Set your bot token
export TELEGRAM_BOT_TOKEN="your-token-here"

# Optional: restrict access to your Telegram chat ID
export ALLOWED_CHAT_IDS="your-chat-id"
```

### 3. Start the Server

```bash
# If installed via one-line installer:
claude-bridge

# If installed manually:
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
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3847/hook/post-tool -H 'Content-Type: application/json' -d @-"
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
| `npm run build` | Build TypeScript to dist/ |
| `npm start` | Run built server from dist/ |

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Connect this chat to ClaudeBridge |
| `/status` | Show mode, pending requests, recent output |
| `/help` | Show available commands |
| `/spawn <task>` | Start a new Claude Code session |
| `/spawn --cwd /path <task>` | Start session in specific directory |
| `/sessions` | List active sessions |
| `/kill <id>` | Kill a session |
| `/context [lines]` | Show recent output from active session |
| `/screenshot` | Capture terminal screenshot of active session |
| `/input <text>` | Send text input to active session |
| `/keys <keys>` | Send keystrokes (e.g., `enter`, `y enter`) |
| `/actions` | Show recent tool actions |
| `/folders` | Manage recent project folders |
| `/allowall` | Enable auto-approve mode |
| `/stopallow` | Disable auto-approve mode |

## Configuration

Configuration can be set via environment variables or `~/.claude-bridge/config.json`:

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | (required) |
| `TELEGRAM_CHAT_ID` | Pre-configured chat ID | (from /start) |
| `ALLOWED_CHAT_IDS` | Comma-separated list of authorized Telegram chat IDs | (none — first /start claims) |
| `PORT` | Server port | 3847 |
| `HOST` | Server host | 127.0.0.1 |
| `LOG_LEVEL` | Log verbosity: `debug`, `info`, `warn`, `error` | info |

## Security

### Bot Authentication

By default, the **first user** to send `/start` claims the bot. Once claimed, no other user can take control. To explicitly restrict access:

```bash
export ALLOWED_CHAT_IDS="123456789,987654321"
```

When `ALLOWED_CHAT_IDS` is set, only those chat IDs can interact with the bot. All commands and callback queries from unauthorized users are silently rejected.

**Recommendation:** Always set `ALLOWED_CHAT_IDS` in production to prevent unauthorized access if someone discovers your bot's username.

### Config File Permissions

The config file at `~/.claude-bridge/config.json` (which stores your bot token) is written with restrictive permissions:
- Directory: `0700` (owner-only access)
- File: `0600` (owner-only read/write)

### Logging

At the default `info` log level, sensitive data (tool inputs, keystrokes, task descriptions) is suppressed. Set `LOG_LEVEL=debug` only during development.

## Development Phases

- [x] Phase 0: POC - Hook bidirectional communication
- [x] Phase 1: Basic Approval Bridge (Telegram integration)
- [ ] Phase 2: Front-end AI Integration
- [ ] Phase 3: Session Management (enhanced)
- [ ] Phase 4: Polish & Robustness

## Project Structure

```
claude-bridge/
├── src/
│   ├── index.ts              # Usage information
│   ├── server.ts             # Main server (Fastify + Telegram)
│   ├── core/
│   │   ├── config.ts         # Configuration & logger
│   │   ├── session-manager.ts # PTY session management
│   │   ├── output-parser.ts  # Terminal output parsing
│   │   └── types.ts          # Shared type definitions
│   ├── telegram/
│   │   └── bot.ts            # Telegram bot (grammY)
│   └── poc/                  # Phase 0 POC code
│       ├── hook-server.ts
│       └── test-hook.ts
├── install.sh                # Local installer
├── install-remote.sh         # Remote SSH installer
├── uninstall.sh              # Uninstaller
├── .env.example              # Environment template
├── package.json
├── tsconfig.json
├── LICENSE
└── README.md
```

## Timeout Handling

- Permission requests timeout after **10 minutes** (Claude Code default)
- At **8 minutes**, you'll receive a warning in Telegram
- If not answered by **10 minutes**, the request is auto-denied

## License

MIT
