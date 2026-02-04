#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

INSTALL_DIR="$HOME/.claude-bridge"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     ClaudeBridge Installer v0.1.0      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Check prerequisites
check_prereqs() {
    echo -e "${YELLOW}Checking prerequisites...${NC}"

    # Check Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}✗ Node.js is not installed${NC}"
        echo "  Please install Node.js 18+ from https://nodejs.org"
        exit 1
    fi
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo -e "${RED}✗ Node.js version must be 18 or higher (found v$NODE_VERSION)${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

    # Check npm
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}✗ npm is not installed${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ npm $(npm -v)${NC}"

    # Check Claude Code
    if ! command -v claude &> /dev/null; then
        echo -e "${RED}✗ Claude Code CLI is not installed${NC}"
        echo "  Please install Claude Code from https://claude.ai/code"
        exit 1
    fi
    echo -e "${GREEN}✓ Claude Code CLI found${NC}"

    # Check curl (for hooks)
    if ! command -v curl &> /dev/null; then
        echo -e "${RED}✗ curl is not installed${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ curl found${NC}"

    echo ""
}

# Install the application
install_app() {
    echo -e "${YELLOW}Installing ClaudeBridge...${NC}"

    # Check if already installed
    if [ -d "$INSTALL_DIR" ]; then
        echo -e "${YELLOW}ClaudeBridge is already installed at $INSTALL_DIR${NC}"
        read -p "Do you want to update it? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Installation cancelled."
            exit 0
        fi
        echo -e "${YELLOW}Updating existing installation...${NC}"
        cd "$INSTALL_DIR"
        git pull origin main 2>/dev/null || true
    else
        # Clone or copy
        if [ -d "$(dirname "$0")/.git" ]; then
            # We're running from the repo, copy it
            echo "Copying from current directory..."
            mkdir -p "$INSTALL_DIR"
            cp -r "$(dirname "$0")"/* "$INSTALL_DIR/"
            cp -r "$(dirname "$0")"/.env* "$INSTALL_DIR/" 2>/dev/null || true
        else
            # Clone from GitHub (update with actual repo URL)
            echo "Cloning from GitHub..."
            git clone https://github.com/digaomatias/claude-bridge.git "$INSTALL_DIR"
        fi
        cd "$INSTALL_DIR"
    fi

    # Install dependencies
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install

    # Build
    echo -e "${YELLOW}Building...${NC}"
    npm run build

    echo -e "${GREEN}✓ ClaudeBridge installed at $INSTALL_DIR${NC}"
    echo ""
}

# Setup environment file
setup_env() {
    echo -e "${YELLOW}Setting up configuration...${NC}"

    ENV_FILE="$INSTALL_DIR/.env"

    if [ -f "$ENV_FILE" ]; then
        echo -e "${GREEN}✓ .env file already exists${NC}"
        read -p "Do you want to reconfigure? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            return
        fi
    fi

    echo ""
    echo -e "${BLUE}You need a Telegram Bot Token from @BotFather${NC}"
    echo "1. Open Telegram and search for @BotFather"
    echo "2. Send /newbot and follow the instructions"
    echo "3. Copy the token provided"
    echo ""

    read -p "Enter your Telegram Bot Token: " BOT_TOKEN

    if [ -z "$BOT_TOKEN" ]; then
        echo -e "${RED}No token provided. You can add it later to $ENV_FILE${NC}"
        cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
    elif ! echo "$BOT_TOKEN" | grep -qE '^[0-9]+:[A-Za-z0-9_-]+$'; then
        echo -e "${RED}Invalid token format. Expected format: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11${NC}"
        echo -e "${RED}You can add it later to $ENV_FILE${NC}"
        cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
    else
        cat > "$ENV_FILE" << EOF
# ClaudeBridge Configuration
TELEGRAM_BOT_TOKEN=$BOT_TOKEN

# Optional: Pre-configure chat ID (get from /start command)
# TELEGRAM_CHAT_ID=

# Server configuration
PORT=3847
HOST=127.0.0.1
EOF
        echo -e "${GREEN}✓ Configuration saved${NC}"
    fi
    echo ""
}

# Setup Claude Code hooks
setup_hooks() {
    echo -e "${YELLOW}Setting up Claude Code hooks...${NC}"

    # Ensure .claude directory exists
    mkdir -p "$HOME/.claude"

    # Define the hooks we need to add
    HOOKS_JSON=$(cat << 'HOOKEOF'
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
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3847/hook/pretool -H 'Content-Type: application/json' -d @-"
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
HOOKEOF
)

    if [ -f "$CLAUDE_SETTINGS" ]; then
        # Check if hooks already exist
        if grep -q "localhost:3847" "$CLAUDE_SETTINGS" 2>/dev/null; then
            echo -e "${GREEN}✓ ClaudeBridge hooks already configured${NC}"
        else
            echo -e "${YELLOW}Existing settings.json found.${NC}"
            echo "Please manually add these hooks to $CLAUDE_SETTINGS:"
            echo ""
            echo "$HOOKS_JSON"
            echo ""
            echo "Or backup your settings and let us merge them:"
            read -p "Attempt automatic merge? (y/n) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                # Backup existing
                cp "$CLAUDE_SETTINGS" "$CLAUDE_SETTINGS.backup.$(date +%Y%m%d%H%M%S)"
                echo -e "${GREEN}✓ Backup created${NC}"

                # Use node to merge JSON (pass path via env to avoid injection)
                CLAUDE_SETTINGS="$CLAUDE_SETTINGS" HOOKS_JSON="$HOOKS_JSON" node -e '
                const fs = require("fs");
                const settingsPath = process.env.CLAUDE_SETTINGS;
                const existing = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
                const newHooks = JSON.parse(process.env.HOOKS_JSON);

                // Merge hooks
                if (!existing.hooks) existing.hooks = {};

                // Check if our hooks already exist
                const hasHook = (hookType) => existing.hooks[hookType]?.some(h =>
                    h.hooks?.some(hh => hh.command?.includes("localhost:3847"))
                );

                // Add each hook type if not present
                for (const [hookType, hookConfigs] of Object.entries(newHooks.hooks)) {
                    if (!existing.hooks[hookType]) existing.hooks[hookType] = [];
                    if (!hasHook(hookType)) {
                        existing.hooks[hookType].push(...hookConfigs);
                    }
                }

                fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
                console.log("Hooks merged successfully");
                '
                echo -e "${GREEN}✓ Hooks added to Claude Code settings${NC}"
            fi
        fi
    else
        # Create new settings file
        echo "$HOOKS_JSON" > "$CLAUDE_SETTINGS"
        echo -e "${GREEN}✓ Created $CLAUDE_SETTINGS with hooks${NC}"
    fi
    echo ""
}

# Create launch script
create_launcher() {
    echo -e "${YELLOW}Creating launcher...${NC}"

    LAUNCHER="$HOME/.local/bin/claude-bridge"
    mkdir -p "$HOME/.local/bin"

    cat > "$LAUNCHER" << 'LAUNCHER'
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

    chmod +x "$LAUNCHER"

    # Check if ~/.local/bin is in PATH
    if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
        echo -e "${YELLOW}Add this to your shell profile (.bashrc or .zshrc):${NC}"
        echo '  export PATH="$HOME/.local/bin:$PATH"'
        echo ""
    fi

    echo -e "${GREEN}✓ Launcher created at $LAUNCHER${NC}"
    echo ""
}

# Print completion message
print_complete() {
    echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║     Installation Complete! 🎉          ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${BLUE}To start ClaudeBridge:${NC}"
    echo "  cd $INSTALL_DIR && npm start"
    echo ""
    echo -e "${BLUE}Or use the launcher:${NC}"
    echo "  claude-bridge"
    echo ""
    echo -e "${BLUE}First time setup:${NC}"
    echo "  1. Start the bot: npm start"
    echo "  2. Open Telegram and message your bot"
    echo "  3. Send /start to connect"
    echo "  4. Use /spawn <task> to start a Claude Code session"
    echo ""
    echo -e "${BLUE}Documentation:${NC}"
    echo "  $INSTALL_DIR/README.md"
    echo ""
}

# Main installation flow
main() {
    check_prereqs
    install_app
    setup_env
    setup_hooks
    create_launcher
    print_complete
}

# Run main
main
