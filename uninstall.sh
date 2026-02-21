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
LAUNCHER="$HOME/.local/bin/claude-bridge"

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║    ClaudeBridge Uninstaller            ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

echo -e "${YELLOW}This will remove:${NC}"
echo "  - $INSTALL_DIR (including .hook-secret and audit.log)"
echo "  - $LAUNCHER"
echo "  - ClaudeBridge hooks from Claude Code settings"
echo ""

read -p "Are you sure you want to uninstall? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Uninstall cancelled."
    exit 0
fi

echo ""

# Remove hooks from Claude settings
if [ -f "$CLAUDE_SETTINGS" ]; then
    echo -e "${YELLOW}Removing hooks from Claude Code settings...${NC}"
    if grep -q "localhost:3847" "$CLAUDE_SETTINGS" 2>/dev/null; then
        # Backup first
        cp "$CLAUDE_SETTINGS" "$CLAUDE_SETTINGS.backup.$(date +%Y%m%d%H%M%S)"

        # Remove hooks using node (both PreToolUse and PostToolUse)
        CLAUDE_SETTINGS="$CLAUDE_SETTINGS" node -e '
        const fs = require("fs");
        const settingsPath = process.env.CLAUDE_SETTINGS;
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

        const hookTypes = ["PreToolUse", "PostToolUse", "PermissionRequest"];

        for (const hookType of hookTypes) {
            if (settings.hooks && settings.hooks[hookType]) {
                settings.hooks[hookType] = settings.hooks[hookType].filter(h =>
                    !h.hooks?.some(hh => hh.command?.includes("localhost:3847"))
                );
                if (settings.hooks[hookType].length === 0) {
                    delete settings.hooks[hookType];
                }
            }
        }

        if (settings.hooks && Object.keys(settings.hooks).length === 0) {
            delete settings.hooks;
        }

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        ' 2>/dev/null || echo "Could not automatically remove hooks"

        echo -e "${GREEN}✓ Hooks removed${NC}"
    else
        echo -e "${GREEN}✓ No ClaudeBridge hooks found${NC}"
    fi
fi

# Remove launcher
if [ -f "$LAUNCHER" ]; then
    echo -e "${YELLOW}Removing launcher...${NC}"
    rm -f "$LAUNCHER"
    echo -e "${GREEN}✓ Launcher removed${NC}"
fi

# Remove installation directory
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}Removing installation directory...${NC}"
    rm -rf "$INSTALL_DIR"
    echo -e "${GREEN}✓ Installation directory removed${NC}"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Uninstall Complete                 ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo "ClaudeBridge has been removed from your system."
echo ""
