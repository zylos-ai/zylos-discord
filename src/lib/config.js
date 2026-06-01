/**
 * Configuration loader for zylos-discord
 *
 * Loads config from ~/zylos/components/discord/config.json
 * with hot-reload support via file watcher.
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/discord');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ENV_PATH = path.join(HOME, 'zylos/.env');

// Default configuration
export const DEFAULT_CONFIG = {
  enabled: true,
  botToken: null,
  applicationId: null,
  owner: null,
  dmPolicy: 'owner',
  dmAllowFrom: [],
  groupPolicy: 'allowlist',
  channels: {},
  features: { downloadMedia: true },
  historyLimit: 5,
  internalPort: 3475
};

let config = null;
let configWatcher = null;
let configReloadTimer = null;

function loadDotEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) return;
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      if (!key || process.env[key] !== undefined) continue;
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (err) {
    console.warn(`[discord] Failed to load ${ENV_PATH}: ${err.message}`);
  }
}

function deepMerge(defaults, overrides = {}) {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      defaults[key] &&
      typeof defaults[key] === 'object' &&
      !Array.isArray(defaults[key])
    ) {
      result[key] = deepMerge(defaults[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function mergeConfigWithDefaults(parsed = {}) {
  const normalized = { ...parsed };
  if (!normalized.botToken && parsed.bot_token) {
    normalized.botToken = parsed.bot_token;
  }
  if (!normalized.applicationId && parsed.application_id) {
    normalized.applicationId = parsed.application_id;
  }

  return deepMerge(DEFAULT_CONFIG, normalized);
}

/**
 * Load configuration from file
 * @returns {Object} Configuration object
 */
export function loadConfig() {
  loadDotEnv();
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      config = mergeConfigWithDefaults(JSON.parse(content));
    } else {
      console.warn(`[discord] Config file not found: ${CONFIG_PATH}`);
      config = mergeConfigWithDefaults();
    }
  } catch (err) {
    console.error(`[discord] Failed to load config: ${err.message}`);
    config = mergeConfigWithDefaults();
  }
  return config;
}

/**
 * Get current configuration
 * @returns {Object} Configuration object
 */
export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

/**
 * Save configuration to file
 * @param {Object} newConfig - Configuration to save
 */
export function saveConfig(newConfig) {
  const tmpPath = CONFIG_PATH + '.tmp';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, CONFIG_PATH);
    config = newConfig;
    return true;
  } catch (err) {
    console.error(`[discord] Failed to save config: ${err.message}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  }
}

/**
 * Start watching config file for changes
 * @param {Function} onChange - Callback when config changes
 */
export function watchConfig(onChange) {
  if (configWatcher) {
    configWatcher.close();
  }
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }

  const configDir = path.dirname(CONFIG_PATH);
  const configBase = path.basename(CONFIG_PATH);

  const scheduleReload = () => {
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(() => {
      configReloadTimer = null;
      if (!fs.existsSync(CONFIG_PATH)) {
        return;
      }
      console.log('[discord] Config file changed, reloading...');
      loadConfig();
      if (onChange) {
        onChange(config);
      }
    }, 100);
  };

  if (fs.existsSync(configDir)) {
    configWatcher = fs.watch(configDir, (eventType, filename) => {
      if ((eventType === 'change' || eventType === 'rename') && filename && String(filename) === configBase) {
        scheduleReload();
      }
    });
    configWatcher.on('error', (err) => {
      console.warn(`[discord] Config watcher error: ${err.message}`);
      if (configReloadTimer) {
        clearTimeout(configReloadTimer);
        configReloadTimer = null;
      }
      try {
        configWatcher.close();
      } catch {}
      configWatcher = null;
    });
  }

  return stopWatching;
}

/**
 * Stop watching config file
 */
export function stopWatching() {
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}

export function getBotToken() {
  const cfg = getConfig();
  return cfg.botToken || process.env.DISCORD_BOT_TOKEN || '';
}

export function getApplicationId() {
  const cfg = getConfig();
  return cfg.applicationId || process.env.DISCORD_APPLICATION_ID || '';
}
