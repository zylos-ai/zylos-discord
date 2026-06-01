#!/usr/bin/env node
/**
 * zylos-discord
 *
 * Discord bot channel for Zylos agents.
 */

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import {
  bindOwnerIfUnset,
  hasOwner,
  isChannelAllowed,
  isDmAuthorized,
  isOwner,
  isSenderAllowed,
  isSmartChannel
} from './lib/auth.js';
import { buildEndpoint, formatDmMessage, formatGroupMessage, sendToC4 } from './lib/c4.js';
import { DATA_DIR, getBotToken, getConfig, loadConfig, saveConfig, watchConfig } from './lib/config.js';
import { channelHistoryLimit, ensureReplay, getHistory } from './lib/context.js';
import { isSelfOrBotMessage, normalizeGatewayError, validateToken } from './lib/discord.js';
import { clearReaction, setReaction, startTyping, stopAllTyping, stopTyping } from './lib/reactions.js';
import { recordIncoming, startRecordingServer, stopRecordingServer } from './lib/recording.js';

const LOG = '[discord]';

let client = null;
let configWatcherStop = null;
let shuttingDown = false;

console.log(`${LOG} Starting...`);
console.log(`${LOG} Data directory: ${DATA_DIR}`);

async function main() {
  const config = getConfig();
  console.log(`${LOG} Config loaded, enabled: ${config.enabled}`);

  if (!config.enabled) {
    console.log(`${LOG} Component disabled in config, exiting.`);
    process.exit(0);
  }

  const token = getBotToken();
  const check = await validateToken(token);
  if (!check.ok) {
    console.error(`${LOG} token validation failed: ${check.error}`);
    process.exit(1);
  }
  console.log(`${LOG} token OK - bot user ${check.tag || check.username} (${check.id})`);

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`${LOG} gateway ready as ${readyClient.user.tag} (${readyClient.user.id})`);
  });

  client.on(Events.MessageCreate, (message) => {
    if (isSelfOrBotMessage(message, client.user?.id)) return;
    if (message.channel?.isDMBased?.()) {
      handleDirectMessage(message).catch((err) => {
        console.error(`${LOG} DM handler failed: ${err.message}`);
      });
      return;
    }
    if (message.inGuild?.()) {
      handleGuildMessage(message).catch((err) => {
        console.error(`${LOG} guild handler failed: ${err.message}`);
      });
    }
  });

  client.on(Events.Error, (err) => {
    console.error(`${LOG} client error: ${err.message}`);
  });

  client.on(Events.ShardError, (err, shardId) => {
    console.error(`${LOG} shard error shard=${shardId}: ${err.message}`);
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`${LOG} shard disconnect shard=${shardId} code=${event?.code}`);
    const normalized = normalizeGatewayError(event);
    if (normalized.disallowedIntents) {
      console.error(`${LOG} ${normalized.message}`);
    }
  });

  client.on(Events.Invalidated, () => {
    console.error(`${LOG} session invalidated; exiting for PM2 restart`);
    shutdown(1);
  });

  configWatcherStop = watchConfig((newConfig) => {
    console.log(`${LOG} Config reloaded`);
    if (!newConfig.enabled) {
      console.log(`${LOG} Component disabled, stopping...`);
      shutdown(0);
    }
  });

  startRecordingServer({ port: config.internalPort || 3475 });

  try {
    await client.login(token);
  } catch (err) {
    const normalized = normalizeGatewayError(err);
    console.error(`${LOG} gateway login failed: ${normalized.message}`);
    process.exit(1);
  }
}

function resolvePolicyChannelId(message) {
  const isThread = message.channel?.isThread?.() || false;
  return isThread ? (message.channel.parentId || message.channel.id) : message.channel.id;
}

function resolveChannelName(config, message, policyChannelId, isThread) {
  const configuredName = config.channels?.[String(policyChannelId)]?.name;
  const parentName = configuredName || message.channel?.parent?.name || String(policyChannelId);
  if (!isThread) {
    return configuredName || message.channel?.name || String(policyChannelId);
  }

  const threadName = message.channel?.name;
  return threadName ? `${parentName} / ${threadName}` : parentName;
}

async function handleGuildMessage(message) {
  const config = loadConfig();
  const isThread = message.channel?.isThread?.() || false;
  const policyChannelId = resolvePolicyChannelId(message);
  const historyKey = message.channel.id;

  const allowed = isChannelAllowed(config, policyChannelId);
  const smart = isSmartChannel(config, policyChannelId);
  if (!allowed && !smart) return;

  const userId = String(message.author.id);
  if (!isOwner(config, userId) && !isSenderAllowed(config, policyChannelId, userId)) {
    return;
  }

  const text = message.cleanContent || message.content || '';
  if (!text.trim()) return;

  const limit = channelHistoryLimit(config, policyChannelId);
  if (!ensureReplay(historyKey, limit)) {
    console.warn(`${LOG} failed to replay history for channel ${historyKey}; will retry next message`);
  }

  const username = message.author.username || message.author.globalName || userId;
  try {
    recordIncoming({
      channelId: historyKey,
      userId,
      username,
      text,
      messageId: message.id
    });
  } catch (err) {
    console.warn(`${LOG} failed to record incoming guild message: ${err.message}`);
  }

  const mentioned = message.mentions?.has?.(client.user) || false;
  const shouldRespond = smart || mentioned;
  if (!shouldRespond) return;

  const correlationId = `${historyKey}:${message.id}`;
  const endpoint = buildEndpoint(historyKey, { messageId: message.id, correlationId });
  const channelName = resolveChannelName(config, message, policyChannelId, isThread);
  const smartNoMention = smart && !mentioned;
  const history = getHistory(historyKey, message.id, limit);

  await setReaction(message);
  if (!smartNoMention) {
    startTyping(message.channel, correlationId);
  }

  const content = formatGroupMessage({
    channelName,
    username,
    text,
    history,
    isThread,
    smartHint: smartNoMention
  });

  sendToC4('discord', endpoint, content, async (errMsg) => {
    stopTyping(correlationId);
    await clearReaction(message);
    await message.reply(errMsg).catch(() => {});
  });
}

async function handleDirectMessage(message) {
  let config = loadConfig();
  const userId = String(message.author.id);
  const username = message.author.username || message.author.globalName || userId;
  const text = message.content || '';

  if (!hasOwner(config)) {
    bindOwnerIfUnset(config, userId);
    if (!saveConfig(config)) {
      await message.reply('Internal error, please try again.').catch(() => {});
      return;
    }
    await message.reply('You are now the owner (admin) of this bot.').catch(() => {});
  }

  if (!text.trim()) {
    await message.reply('Attachments are not supported yet. Please send text.').catch(() => {});
    return;
  }

  config = loadConfig();
  if (!isDmAuthorized(config, userId)) {
    await message.reply('Sorry, this bot is private.').catch(() => {});
    return;
  }

  const correlationId = `${message.channel.id}:${message.id}`;
  const endpoint = buildEndpoint(message.channel.id, { messageId: message.id, correlationId });

  try {
    recordIncoming({
      channelId: message.channel.id,
      userId,
      username,
      text,
      messageId: message.id
    });
  } catch (err) {
    console.warn(`${LOG} failed to record incoming DM: ${err.message}`);
  }

  await setReaction(message);
  startTyping(message.channel, correlationId);

  const content = formatDmMessage({ username, text });
  sendToC4('discord', endpoint, content, async (errMsg) => {
    stopTyping(correlationId);
    await clearReaction(message);
    await message.reply(errMsg).catch(() => {});
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${LOG} Shutting down...`);
  try {
    configWatcherStop?.();
  } catch {}
  try {
    stopAllTyping();
  } catch {}
  try {
    stopRecordingServer();
  } catch {}
  try {
    client?.destroy();
  } catch {}
  process.exit(code);
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error(`${LOG} Fatal error:`, err);
  process.exit(1);
});
