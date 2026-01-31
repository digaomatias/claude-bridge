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

## Current Status: Phase 0 - POC

Proving bidirectional communication between Claude Code hooks and our server.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Hook Server

```bash
npm run poc:server
```

### 3. Test the Hook (in another terminal)

```bash
npm run poc:test
```

### 4. Configure Claude Code Hooks

Add the following to your Claude Code settings (`.claude/settings.json`):

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

## Hook Server Commands

When the hook server is running, you can use these commands:

- `allow [id]` - Approve the request
- `deny [id]` - Deny the request
- `list` - Show pending requests
- `help` - Show help
- `quit` - Stop the server

## Development Phases

- [x] Phase 0: POC - Hook bidirectional communication
- [ ] Phase 1: Basic Approval Bridge (Telegram integration)
- [ ] Phase 2: Front-end AI Integration
- [ ] Phase 3: Session Management
- [ ] Phase 4: Polish & Robustness

## Project Structure

```
claude-bridge/
├── src/
│   ├── index.ts           # Main entry point
│   ├── poc/               # Phase 0 POC code
│   │   ├── hook-server.ts # Hook receiver server
│   │   └── test-hook.ts   # Hook test script
│   ├── core/              # Core session management (Phase 3)
│   ├── telegram/          # Telegram bot (Phase 1)
│   └── hooks/             # Hook handling logic
├── hooks/
│   └── claude-hooks.json  # Example Claude Code hook config
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
