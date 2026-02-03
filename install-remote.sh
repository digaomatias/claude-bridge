#!/bin/bash
#
# ClaudeBridge One-Line Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/digaomatias/claude-bridge/main/install-remote.sh | bash
#
# Or with a specific version:
#   curl -fsSL https://raw.githubusercontent.com/digaomatias/claude-bridge/main/install-remote.sh | bash -s -- --version v0.1.0
#

set -e

# Configuration
REPO_OWNER="digaomatias"
REPO_NAME="claude-bridge"
REPO_URL="https://github.com/$REPO_OWNER/$REPO_NAME"
BRANCH="main"

# Installation paths
INSTALL_DIR="$HOME/.claude-bridge"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --version|-v)
            BRANCH="$2"
            shift 2
            ;;
        --help|-h)
            echo "ClaudeBridge Installer"
            echo ""
            echo "Usage: curl -fsSL <url> | bash [-s -- OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --version, -v VERSION   Install specific version/branch"
            echo "  --help, -h              Show this help"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

echo -e "${BLUE}"
cat << 'EOF'
   _____ _                 _      ____       _     _
  / ____| |               | |    |  _ \     (_)   | |
 | |    | | __ _ _   _  __| | ___| |_) |_ __ _  __| | __ _  ___
 | |    | |/ _` | | | |/ _` |/ _ \  _ <| '__| |/ _` |/ _` |/ _ \
 | |____| | (_| | |_| | (_| |  __/ |_) | |  | | (_| | (_| |  __/
  \_____|_|\__,_|\__,_|\__,_|\___|____/|_|  |_|\__,_|\__, |\___|
                                                      __/ |
                                                     |___/
EOF
echo -e "${NC}"
echo -e "${BLUE}One-Line Installer v0.1.0${NC}"
echo ""

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js is not installed${NC}"
    echo ""
    echo "Please install Node.js 18+ first:"
    echo "  macOS:   brew install node"
    echo "  Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
    echo "  Other:   https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}✗ Node.js 18+ required (found v$NODE_VERSION)${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm $(npm -v)${NC}"

# Check git
if ! command -v git &> /dev/null; then
    echo -e "${RED}✗ git is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ git found${NC}"

# Check Claude Code (optional but recommended)
if command -v claude &> /dev/null; then
    echo -e "${GREEN}✓ Claude Code CLI found${NC}"
else
    echo -e "${YELLOW}⚠ Claude Code CLI not found (install from https://claude.ai/code)${NC}"
fi

# Check curl
if ! command -v curl &> /dev/null; then
    echo -e "${RED}✗ curl is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ curl found${NC}"

echo ""

# Download and install
echo -e "${YELLOW}Installing ClaudeBridge...${NC}"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}Existing installation found at $INSTALL_DIR${NC}"
    read -p "Update existing installation? (y/n) " -n 1 -r < /dev/tty
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Installation cancelled."
        exit 0
    fi
    cd "$INSTALL_DIR"
    git fetch origin
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
else
    echo "Cloning from $REPO_URL..."
    git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Install dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
npm install --silent

# Build
echo -e "${YELLOW}Building...${NC}"
npm run build --silent

echo -e "${GREEN}✓ ClaudeBridge installed${NC}"
echo ""

# Setup .env
ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${YELLOW}Configuration needed${NC}"
    echo ""
    echo "You need a Telegram Bot Token:"
    echo "  1. Open Telegram, search for @BotFather"
    echo "  2. Send /newbot and follow prompts"
    echo "  3. Copy the token"
    echo ""

    read -p "Enter Telegram Bot Token (or press Enter to skip): " BOT_TOKEN < /dev/tty

    if [ -n "$BOT_TOKEN" ] && ! echo "$BOT_TOKEN" | grep -qE '^[0-9]+:[A-Za-z0-9_-]+$'; then
        echo -e "${RED}Invalid token format. Expected format: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11${NC}"
        echo -e "${YELLOW}⚠ Edit $ENV_FILE to add your bot token${NC}"
        cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
    elif [ -n "$BOT_TOKEN" ]; then
        cat > "$ENV_FILE" << EOF
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
PORT=3847
HOST=127.0.0.1
EOF
        echo -e "${GREEN}✓ Configuration saved${NC}"
    else
        cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
        echo -e "${YELLOW}⚠ Edit $ENV_FILE to add your bot token${NC}"
    fi
fi
echo ""

# Setup Claude Code hooks
echo -e "${YELLOW}Setting up Claude Code hooks...${NC}"
mkdir -p "$HOME/.claude"

HOOK_COMMAND='curl -s -X POST http://localhost:3847/hook/pretool -H '\''Content-Type: application/json'\'' -d @-'

if [ -f "$CLAUDE_SETTINGS" ]; then
    if grep -q "localhost:3847" "$CLAUDE_SETTINGS" 2>/dev/null; then
        echo -e "${GREEN}✓ Hooks already configured${NC}"
    else
        # Backup and merge
        cp "$CLAUDE_SETTINGS" "$CLAUDE_SETTINGS.backup"

        CLAUDE_SETTINGS="$CLAUDE_SETTINGS" HOOK_COMMAND="$HOOK_COMMAND" node -e '
        const fs = require("fs");
        const settingsPath = process.env.CLAUDE_SETTINGS;
        const hookCommand = process.env.HOOK_COMMAND;
        let settings = {};
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        } catch(e) {}

        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

        const hasHook = settings.hooks.PreToolUse.some(h =>
            h.hooks?.some(hh => hh.command?.includes("localhost:3847"))
        );

        if (!hasHook) {
            settings.hooks.PreToolUse.push({
                matcher: "Bash|Edit|Write|AskUserQuestion",
                hooks: [{
                    type: "command",
                    command: hookCommand
                }]
            });
        }

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        '
        echo -e "${GREEN}✓ Hooks added (backup: $CLAUDE_SETTINGS.backup)${NC}"
    fi
else
    cat > "$CLAUDE_SETTINGS" << EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_COMMAND"
          }
        ]
      }
    ]
  }
}
EOF
    echo -e "${GREEN}✓ Created $CLAUDE_SETTINGS${NC}"
fi
echo ""

# Create launcher
echo -e "${YELLOW}Creating launcher...${NC}"
mkdir -p "$HOME/.local/bin"

cat > "$HOME/.local/bin/claude-bridge" << 'LAUNCHER'
#!/bin/bash
set -e

BRIDGE_DIR="$HOME/.claude-bridge"

case "${1:-start}" in
    start)
        cd "$BRIDGE_DIR"
        exec npm start
        ;;
    update)
        echo "Updating ClaudeBridge..."
        cd "$BRIDGE_DIR"
        git fetch && git pull
        npm install
        npm run build
        VERSION=$(node -p "require('./package.json').version")
        echo "ClaudeBridge updated to v${VERSION}"
        ;;
    uninstall)
        if [ -f "$BRIDGE_DIR/uninstall.sh" ]; then
            exec bash "$BRIDGE_DIR/uninstall.sh"
        else
            echo "Uninstall script not found at $BRIDGE_DIR/uninstall.sh"
            exit 1
        fi
        ;;
    version)
        cd "$BRIDGE_DIR"
        VERSION=$(node -p "require('./package.json').version")
        echo "ClaudeBridge v${VERSION}"
        ;;
    help|--help|-h)
        echo "ClaudeBridge - Control Claude Code from Telegram"
        echo ""
        echo "Usage: claude-bridge [command]"
        echo ""
        echo "Commands:"
        echo "  start       Start the server (default)"
        echo "  update      Pull latest changes and rebuild"
        echo "  uninstall   Remove ClaudeBridge"
        echo "  version     Show current version"
        echo "  help        Show this help message"
        ;;
    *)
        echo "Unknown command: $1"
        echo "Run 'claude-bridge help' for usage information."
        exit 1
        ;;
esac
LAUNCHER
chmod +x "$HOME/.local/bin/claude-bridge"
echo -e "${GREEN}✓ Launcher created${NC}"

# Check PATH
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo ""
    echo -e "${YELLOW}Add to your shell profile (.bashrc/.zshrc):${NC}"
    echo '  export PATH="$HOME/.local/bin:$PATH"'
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Installation Complete! 🎉${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}To start ClaudeBridge:${NC}"
echo "  claude-bridge"
echo ""
echo -e "${BLUE}Or:${NC}"
echo "  cd ~/.claude-bridge && npm start"
echo ""
echo -e "${BLUE}First time:${NC}"
echo "  1. Start the server"
echo "  2. Open Telegram, message your bot"
echo "  3. Send /start to connect"
echo "  4. Use /spawn <task> to start coding!"
echo ""
