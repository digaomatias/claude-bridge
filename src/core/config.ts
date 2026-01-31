/**
 * Configuration Management
 *
 * Handles loading and saving configuration from environment and file.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface Config {
  telegramBotToken: string;
  telegramChatId: string | null;
  serverPort: number;
  serverHost: string;
}

const CONFIG_PATH = path.join(
  process.env.HOME || '~',
  '.claude-bridge',
  'config.json'
);

export function loadConfig(): Config {
  // Start with defaults
  const config: Config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
    serverPort: parseInt(process.env.PORT || '3847', 10),
    serverHost: process.env.HOST || '127.0.0.1',
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
    fs.mkdirSync(dir, { recursive: true });
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  console.log(`Config saved to ${CONFIG_PATH}`);
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
