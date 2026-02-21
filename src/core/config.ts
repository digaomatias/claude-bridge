/**
 * Configuration Management
 *
 * Handles loading and saving configuration from environment and file.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type { AIConfig, AutoApproveRule } from '../ai/types.js';

export interface Config {
  telegramBotToken: string;
  telegramChatId: string | null;
  allowedChatIds: string[];
  serverPort: number;
  serverHost: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  recentFolders: string[];
  ai?: AIConfig;
  autoApproveRules?: AutoApproveRule[];
  insecureMode?: boolean;
}

const CONFIG_PATH = path.join(
  process.env.HOME || '~',
  '.claude-bridge',
  'config.json'
);

export function loadConfig(): Config {
  // Parse allowed chat IDs from env (comma-separated)
  const envAllowedIds = process.env.ALLOWED_CHAT_IDS
    ? process.env.ALLOWED_CHAT_IDS.split(',').map(id => id.trim()).filter(Boolean)
    : [];

  // Check for --insecure flag
  const insecureMode = process.argv.includes('--insecure');

  // Start with defaults
  const config: Config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
    allowedChatIds: envAllowedIds,
    serverPort: parseInt(process.env.PORT || '3847', 10),
    serverHost: process.env.HOST || '127.0.0.1',
    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) || 'info',
    recentFolders: [],
    insecureMode,
  };

  // Try to load from file
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      Object.assign(config, fileConfig);
    }
  } catch (err) {
    console.warn(`Could not load config from ${CONFIG_PATH}:`, err);
  }

  return config;
}

export function saveConfig(config: Partial<Config>): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  let existing: Partial<Config> = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {
    // Ignore errors
  }

  const merged = { ...existing, ...config };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  console.log(`Config saved to ${CONFIG_PATH}`);
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

const MAX_RECENT_FOLDERS = 8;

/**
 * Add a folder to the recent folders list.
 * Adds to front, deduplicates, and limits to MAX_RECENT_FOLDERS.
 */
export function addRecentFolder(folder: string): void {
  const config = loadConfig();
  const folders = config.recentFolders || [];

  // Remove if already exists (will be re-added at front)
  const filtered = folders.filter((f) => f !== folder);

  // Add to front
  filtered.unshift(folder);

  // Limit to max
  const limited = filtered.slice(0, MAX_RECENT_FOLDERS);

  saveConfig({ recentFolders: limited });
}

/**
 * Get the list of recent folders.
 */
export function getRecentFolders(): string[] {
  const config = loadConfig();
  return config.recentFolders || [];
}

/**
 * Remove a folder at the specified index.
 */
export function removeRecentFolder(index: number): boolean {
  const config = loadConfig();
  const folders = config.recentFolders || [];

  if (index < 0 || index >= folders.length) {
    return false;
  }

  folders.splice(index, 1);
  saveConfig({ recentFolders: folders });
  return true;
}

/**
 * Clear all recent folders.
 */
export function clearRecentFolders(): void {
  saveConfig({ recentFolders: [] });
}

/**
 * Simple log-level-aware logger.
 * At 'info' level (default), debug messages are suppressed.
 * At 'debug' level, everything is logged including full payloads.
 */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

let _logLevel: number | null = null;

function getLogLevel(): number {
  if (_logLevel === null) {
    const level = (process.env.LOG_LEVEL || 'info') as keyof typeof LOG_LEVELS;
    _logLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  }
  return _logLevel;
}

const HOOK_SECRET_PATH = path.join(
  process.env.HOME || '~',
  '.claude-bridge',
  '.hook-secret'
);

/**
 * Get the path to the hook secret file.
 */
export function getHookSecretPath(): string {
  return HOOK_SECRET_PATH;
}

/**
 * Read or generate the shared hook secret.
 * Stored as 64-char hex at ~/.claude-bridge/.hook-secret with mode 0600.
 */
export function getOrCreateHookSecret(): string {
  const dir = path.dirname(HOOK_SECRET_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  try {
    if (fs.existsSync(HOOK_SECRET_PATH)) {
      const secret = fs.readFileSync(HOOK_SECRET_PATH, 'utf-8').trim();
      if (secret.length >= 32) {
        return secret;
      }
    }
  } catch {
    // Fall through to generate
  }

  // Generate new secret
  const secret = crypto.randomBytes(32).toString('hex'); // 64-char hex
  fs.writeFileSync(HOOK_SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (getLogLevel() <= LOG_LEVELS.debug) console.log(...args);
  },
  info: (...args: unknown[]) => {
    if (getLogLevel() <= LOG_LEVELS.info) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (getLogLevel() <= LOG_LEVELS.warn) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    if (getLogLevel() <= LOG_LEVELS.error) console.error(...args);
  },
};
