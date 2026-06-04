/**
 * Configuration loader for zylos-discord
 *
 * Loads config from ~/zylos/components/discord/config.json
 * with hot-reload support via file watcher.
 */

import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from './file-lock.js';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/discord');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const STATE_LOCK_PATH = path.join(DATA_DIR, '.state.lock');
const ENV_PATH = path.join(HOME, 'zylos/.env');

// Default configuration
const DM_POLICIES = new Set(['open', 'allowlist', 'owner', 'pairing']);

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
  media: { maxBytes: 10 * 1024 * 1024 },
  historyLimit: 5,
  textMode: 'markdown',
  reactionNotifyMode: 'own',
  voiceTranscription: 'auto',
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

function normalizeVoiceTranscription(value) {
  if (value === false) return 'disabled';
  if (value === true) return DEFAULT_CONFIG.voiceTranscription;
  const normalized = String(value || DEFAULT_CONFIG.voiceTranscription).trim().toLowerCase();
  return ['auto', 'local', 'disabled'].includes(normalized)
    ? normalized
    : DEFAULT_CONFIG.voiceTranscription;
}

export function mergeConfigWithDefaults(parsed = {}) {
  const normalized = { ...parsed };
  if (!normalized.botToken && parsed.bot_token) {
    normalized.botToken = parsed.bot_token;
  }
  if (!normalized.applicationId && parsed.application_id) {
    normalized.applicationId = parsed.application_id;
  }
  if (normalized.textMode && !['plain', 'markdown'].includes(normalized.textMode)) {
    normalized.textMode = DEFAULT_CONFIG.textMode;
  }
  if (normalized.dmPolicy && !DM_POLICIES.has(String(normalized.dmPolicy).trim().toLowerCase())) {
    normalized.dmPolicy = DEFAULT_CONFIG.dmPolicy;
  } else if (normalized.dmPolicy) {
    normalized.dmPolicy = String(normalized.dmPolicy).trim().toLowerCase();
  }
  if (normalized.reactionNotifyMode && !['off', 'own', 'all'].includes(normalized.reactionNotifyMode)) {
    normalized.reactionNotifyMode = DEFAULT_CONFIG.reactionNotifyMode;
  }
  normalized.voiceTranscription = normalizeVoiceTranscription(normalized.voiceTranscription);
  if (normalized.channels && typeof normalized.channels === 'object' && !Array.isArray(normalized.channels)) {
    for (const channel of Object.values(normalized.channels)) {
      if (channel?.reactionNotifyMode && !['off', 'own', 'all'].includes(channel.reactionNotifyMode)) {
        channel.reactionNotifyMode = DEFAULT_CONFIG.reactionNotifyMode;
      }
    }
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
  return withStateLock(() => writeConfigFile(newConfig));
}

function writeConfigFile(newConfig) {
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

export function withStateLock(fn, options = {}) {
  return withFileLockSync(STATE_LOCK_PATH, fn, options);
}

export function updateConfig(mutator) {
  return withStateLock(() => {
    const nextConfig = loadConfig();
    const result = mutator(nextConfig);
    if (result === false) {
      return { ok: true, saved: false, config: nextConfig, result };
    }
    if (!writeConfigFile(nextConfig)) {
      return { ok: false, saved: false, config: nextConfig, result };
    }
    return { ok: true, saved: true, config: nextConfig, result };
  });
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
