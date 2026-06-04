#!/usr/bin/env node
/**
 * zylos-discord admin CLI.
 *
 * Manage Discord bot configuration. Changes apply live through the config
 * watcher; no service restart is required.
 */

import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './lib/config.js';
import {
  approvePairingUser,
  denyPairingUser,
  listPendingPairing,
  loadPairingState,
  savePairingState
} from './lib/dm-pairing.js';

const SNOWFLAKE_RE = /^\d{5,25}$/;
const HISTORY_LIMIT_RE = /^(?:[1-9]\d*)$/;
const DM_POLICIES = new Set(['open', 'allowlist', 'owner', 'pairing']);
const GROUP_POLICIES = new Set(['disabled', 'allowlist', 'open']);
const CHANNEL_MODES = new Set(['mention', 'smart']);
const REACTION_NOTIFY_MODES = new Set(['off', 'own', 'all']);

function print(writer, line = '') {
  writer.write(`${line}\n`);
}

function usageText() {
  return `zylos-discord admin CLI

Changes apply live through config reload.

Commands:
  show
  show-owner
  set-owner <userId>

  set-dm-policy <open|allowlist|owner|pairing>
  add-dm-allow <userId>
  remove-dm-allow <userId>
  list-dm-allow
  dm-pending
  dm-approve <userId>
  dm-deny <userId> [reason]

  set-group-policy <disabled|allowlist|open>
  add-channel <channelId> <name> [mention|smart]  (defaults owner-only)
  remove-channel <channelId>
  list-channels
  set-channel-mode <channelId> <mention|smart>
  set-thread-mode <parentChannelId> <threadId> <mention|smart>
  set-channel-history-limit <channelId> <1..200>
  set-channel-reaction-notify <channelId> <off|own|all>
  add-channel-allow <channelId> <userId|*>
  remove-channel-allow <channelId> <userId|*>
  list-channel-allow <channelId>

  help`;
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function maskToken(value) {
  if (!value) return value ?? null;
  const text = String(value);
  return text.length <= 4 ? '...' : `...${text.slice(-4)}`;
}

function sanitizeForShow(config) {
  const output = cloneConfig(config);
  output.botToken = maskToken(output.botToken);
  if (Object.prototype.hasOwnProperty.call(output, 'bot_token')) {
    output.bot_token = maskToken(output.bot_token);
  }
  return output;
}

function normalizeEnum(value, allowed, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`invalid ${label}`);
  }
  return normalized;
}

function normalizeSnowflake(value, label) {
  const normalized = String(value || '').trim();
  if (!SNOWFLAKE_RE.test(normalized)) {
    throw new Error(`invalid ${label}`);
  }
  return normalized;
}

function normalizeChannelAllowEntry(value) {
  const normalized = String(value || '').trim();
  if (normalized === '*') return normalized;
  return normalizeSnowflake(normalized, 'user id');
}

function normalizeChannelName(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 100 || /[\x00-\x1F\x7F]/.test(normalized)) {
    throw new Error('invalid channel name');
  }
  return normalized;
}

function normalizeHistoryLimit(value) {
  const normalized = String(value || '').trim();
  if (!HISTORY_LIMIT_RE.test(normalized)) {
    throw new Error('invalid history limit');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new Error('invalid history limit');
  }
  return parsed;
}

function ensureDmAllow(config) {
  if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
  config.dmAllowFrom = config.dmAllowFrom.map(String);
  return config.dmAllowFrom;
}

function ensureChannels(config) {
  if (!config.channels || typeof config.channels !== 'object' || Array.isArray(config.channels)) {
    config.channels = {};
  }
  return config.channels;
}

function requireChannel(config, channelId) {
  const channels = ensureChannels(config);
  const channel = channels[String(channelId)];
  if (!channel) {
    throw new Error('channel not configured; add-channel first');
  }
  if (!Array.isArray(channel.allowFrom)) channel.allowFrom = [];
  channel.allowFrom = channel.allowFrom.map(String);
  return channel;
}

function ensureThreads(channel) {
  if (!channel.threads || typeof channel.threads !== 'object' || Array.isArray(channel.threads)) {
    channel.threads = {};
  }
  return channel.threads;
}

function defaultChannelAllowFrom(config, ctx) {
  if (config.owner) return [String(config.owner)];
  print(ctx.stderr, 'Owner not configured; channel allowFrom defaults to anyone');
  return [];
}

function addUnique(list, value) {
  const normalized = String(value);
  if (list.map(String).includes(normalized)) return false;
  list.push(normalized);
  return true;
}

function removeValue(list, value) {
  const normalized = String(value);
  const before = list.length;
  const filtered = list.filter((entry) => String(entry) !== normalized);
  list.splice(0, list.length, ...filtered);
  return before !== list.length;
}

function saveOrThrow(config, saveFn) {
  if (!saveFn(config)) {
    throw new Error('failed to save config');
  }
}

function makeContext(options = {}) {
  return {
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
    loadConfig: options.loadConfig || loadConfig,
    saveConfig: options.saveConfig || saveConfig,
    loadPairingState: options.loadPairingState || loadPairingState,
    savePairingState: options.savePairingState || savePairingState
  };
}

function success(ctx, message) {
  print(ctx.stdout, `${message} (saved; changes apply live)`);
  return 0;
}

export function runAdmin(argv = [], options = {}) {
  const ctx = makeContext(options);
  const [command = 'help', ...args] = argv;

  try {
    switch (command) {
      case 'help':
        print(ctx.stdout, usageText());
        return 0;

      case 'show': {
        const config = ctx.loadConfig();
        print(ctx.stdout, JSON.stringify(sanitizeForShow(config), null, 2));
        return 0;
      }

      case 'show-owner': {
        const config = ctx.loadConfig();
        print(ctx.stdout, config.owner ? `Owner: ${String(config.owner)}` : 'No owner configured');
        return 0;
      }

      case 'set-owner': {
        const userId = normalizeSnowflake(args[0], 'user id');
        const config = ctx.loadConfig();
        config.owner = userId;
        saveOrThrow(config, ctx.saveConfig);
        return success(ctx, `Set owner=${userId}`);
      }

      case 'set-dm-policy': {
        const policy = normalizeEnum(args[0], DM_POLICIES, 'dmPolicy');
        const config = ctx.loadConfig();
        config.dmPolicy = policy;
        saveOrThrow(config, ctx.saveConfig);
        return success(ctx, `Set dmPolicy=${policy}`);
      }

      case 'add-dm-allow': {
        const userId = normalizeSnowflake(args[0], 'user id');
        const config = ctx.loadConfig();
        const allow = ensureDmAllow(config);
        const added = addUnique(allow, userId);
        if (added) {
          saveOrThrow(config, ctx.saveConfig);
          return success(ctx, `Added ${userId} to dmAllowFrom`);
        }
        print(ctx.stdout, `${userId} already in dmAllowFrom`);
        return 0;
      }

      case 'remove-dm-allow': {
        const userId = normalizeSnowflake(args[0], 'user id');
        const config = ctx.loadConfig();
        const allow = ensureDmAllow(config);
        const removed = removeValue(allow, userId);
        if (removed) {
          saveOrThrow(config, ctx.saveConfig);
          return success(ctx, `Removed ${userId} from dmAllowFrom`);
        }
        print(ctx.stdout, `${userId} not found in dmAllowFrom`);
        return 0;
      }

      case 'list-dm-allow': {
        const config = ctx.loadConfig();
        const allow = ensureDmAllow(config);
        print(ctx.stdout, `DM policy: ${config.dmPolicy || 'owner'}`);
        print(ctx.stdout, `DM allowFrom (${allow.length}): ${allow.length ? allow.join(', ') : 'none'}`);
        return 0;
      }

      case 'dm-pending': {
        const state = ctx.loadPairingState();
        const pending = listPendingPairing(state);
        if (pending.length === 0) {
          print(ctx.stdout, 'No pending DM pairing requests');
          return 0;
        }
        for (const entry of pending) {
          print(ctx.stdout, `${entry.userId} - ${entry.name || 'unknown'}`);
          print(ctx.stdout, `  requestedAt: ${entry.requestedAt || 'unknown'}`);
          print(ctx.stdout, `  firstMessage: ${entry.firstMessage || ''}`);
        }
        return 0;
      }

      case 'dm-approve': {
        const userId = normalizeSnowflake(args[0], 'user id');
        const config = ctx.loadConfig();
        const state = ctx.loadPairingState();
        approvePairingUser(config, userId, state);
        saveOrThrow(config, ctx.saveConfig);
        if (!ctx.savePairingState(state)) {
          throw new Error('failed to save pairing state');
        }
        return success(ctx, `Approved DM pairing request for ${userId}`);
      }

      case 'dm-deny': {
        const userId = normalizeSnowflake(args[0], 'user id');
        const reason = args.slice(1).join(' ');
        const config = ctx.loadConfig();
        const state = ctx.loadPairingState();
        denyPairingUser(config, userId, reason, state);
        saveOrThrow(config, ctx.saveConfig);
        if (!ctx.savePairingState(state)) {
          throw new Error('failed to save pairing state');
        }
        return success(ctx, `Denied DM pairing request for ${userId}`);
      }

      case 'set-group-policy': {
        const policy = normalizeEnum(args[0], GROUP_POLICIES, 'groupPolicy');
        const config = ctx.loadConfig();
        config.groupPolicy = policy;
        saveOrThrow(config, ctx.saveConfig);
        return success(ctx, `Set groupPolicy=${policy}`);
      }

      case 'add-channel': {
        const channelId = normalizeSnowflake(args[0], 'channel id');
        const name = normalizeChannelName(args[1]);
        const mode = args[2] ? normalizeEnum(args[2], CHANNEL_MODES, 'mode') : 'mention';
        const config = ctx.loadConfig();
        const channels = ensureChannels(config);
        if (channels[channelId]) {
          print(ctx.stdout, `Channel ${channelId} already configured`);
          return 0;
        }
        channels[channelId] = { name, mode, allowFrom: defaultChannelAllowFrom(config, ctx) };
        saveOrThrow(config, ctx.saveConfig);
        return success(ctx, `Added channel ${channelId} (${name}) mode=${mode}`);
      }

      case 'remove-channel': {
        const channelId = normalizeSnowflake(args[0], 'channel id');
        const config = ctx.loadConfig();
        const channels = ensureChannels(config);
        if (!channels[channelId]) {
          print(ctx.stdout, `Channel ${channelId} not configured`);
          return 0;
        }
        delete channels[channelId];
        saveOrThrow(config, ctx.saveConfig);
        return success(ctx, `Removed channel ${channelId}`);
      }

      case 'list-channels': {
        const config = ctx.loadConfig();
        const channels = ensureChannels(config);
        const ids = Object.keys(channels);
        print(ctx.stdout, `Group policy: ${config.groupPolicy || 'allowlist'}`);
        if (ids.length === 0) {
          print(ctx.stdout, 'No channels configured');
          return 0;
        }
        for (const id of ids) {
          const channel = channels[id] || {};
          const allow = Array.isArray(channel.allowFrom) && channel.allowFrom.length
            ? channel.allowFrom.map(String).join(', ')
            : 'anyone';
          print(ctx.stdout, `${id} - ${channel.name || 'channel'}`);
          print(ctx.stdout, `  mode: ${channel.mode || 'mention'}`);
          print(ctx.stdout, `  allowFrom: ${allow}`);
          print(ctx.stdout, `  historyLimit: ${channel.historyLimit || config.historyLimit || 5}`);
          print(ctx.stdout, `  reactionNotifyMode: ${channel.reactionNotifyMode || config.reactionNotifyMode || 'own'}`);
          const threads = channel.threads && typeof channel.threads === 'object' && !Array.isArray(channel.threads)
            ? Object.entries(channel.threads)
            : [];
          for (const [threadId, thread] of threads) {
            print(ctx.stdout, `  thread ${threadId}: mode=${thread?.mode || channel.mode || 'mention'}`);
          }
        }
        return 0;
      }

      case 'set-channel-mode': {
        const channelId = normalizeSnowflake(args[0], 'channel id');
        const mode = normalizeEnum(args[1], CHANNEL_MODES, 'mode');
        const config = ctx.loadConfig();
        requireChannel(config, channelId).mode = mode;
        saveOrThrow(config, ctx.saveConfig);
        return success(ctx, `Set channel ${channelId} mode=${mode}`);
      }

      case 'set-thread-mode': {
        const channelId = normalizeSnowflake(args[0], 'channel id');
        const threadId = normalizeSnowflake(args[1], 'thread id');
        const mode = normalizeEnum(args[2], CHANNEL_MODES, 'mode');
        const config = ctx.loadConfig();
        const channel = requireChannel(config, channelId);
        ensureThreads(channel)[threadId] = {
          ...(channel.threads?.[threadId] || {}),
          mode
        };
        saveOrThrow(config, ctx.saveConfig);
        return success(ctx, `Set thread ${threadId} mode=${mode}`);
      }

      case 'set-channel-history-limit': {
        const channelId = normalizeSnowflake(args[0], 'channel id');
        const limit = normalizeHistoryLimit(args[1]);
        const config = ctx.loadConfig();
        requireChannel(config, channelId).historyLimit = limit;
        saveOrThrow(config, ctx.saveConfig);
        return success(ctx, `Set channel ${channelId} historyLimit=${limit}`);
      }

      case 'set-channel-reaction-notify': {
        const channelId = normalizeSnowflake(args[0], 'channel id');
        const mode = normalizeEnum(args[1], REACTION_NOTIFY_MODES, 'reactionNotifyMode');
        const config = ctx.loadConfig();
        requireChannel(config, channelId).reactionNotifyMode = mode;
        saveOrThrow(config, ctx.saveConfig);
        return success(ctx, `Set channel ${channelId} reactionNotifyMode=${mode}`);
      }

      case 'add-channel-allow': {
        const channelId = normalizeSnowflake(args[0], 'channel id');
        const userId = normalizeChannelAllowEntry(args[1]);
        const config = ctx.loadConfig();
        const channel = requireChannel(config, channelId);
        const added = addUnique(channel.allowFrom, userId);
        if (added) {
          saveOrThrow(config, ctx.saveConfig);
          return success(ctx, `Added ${userId} to channel ${channelId} allowFrom`);
        }
        print(ctx.stdout, `${userId} already in channel ${channelId} allowFrom`);
        return 0;
      }

      case 'remove-channel-allow': {
        const channelId = normalizeSnowflake(args[0], 'channel id');
        const userId = normalizeChannelAllowEntry(args[1]);
        const config = ctx.loadConfig();
        const channel = requireChannel(config, channelId);
        const removed = removeValue(channel.allowFrom, userId);
        if (removed) {
          saveOrThrow(config, ctx.saveConfig);
          return success(ctx, `Removed ${userId} from channel ${channelId} allowFrom`);
        }
        print(ctx.stdout, `${userId} not found in channel ${channelId} allowFrom`);
        return 0;
      }

      case 'list-channel-allow': {
        const channelId = normalizeSnowflake(args[0], 'channel id');
        const config = ctx.loadConfig();
        const channel = requireChannel(config, channelId);
        print(ctx.stdout, `Channel ${channelId} allowFrom (${channel.allowFrom.length}): ${channel.allowFrom.length ? channel.allowFrom.join(', ') : 'anyone'}`);
        return 0;
      }

      default:
        print(ctx.stderr, `Unknown command: ${command}`);
        print(ctx.stderr, usageText());
        return 1;
    }
  } catch (err) {
    print(ctx.stderr, `Error: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runAdmin(process.argv.slice(2));
}
