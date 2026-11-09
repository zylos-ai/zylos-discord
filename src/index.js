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
  isDmAuthorized,
  resolveGuildAccess
} from './lib/auth.js';
import {
  buildEventEndpoint,
  buildEndpoint,
  formatDmMessage,
  formatGroupMessage,
  formatMessageDeleteEvent,
  formatMessageEditEvent,
  formatReactionEvent,
  sendToC4
} from './lib/c4.js';
import { DATA_DIR, getBotToken, getConfig, saveConfig, updateConfig, watchConfig } from './lib/config.js';
import { channelHistoryLimit, ensureReplay, getHistory } from './lib/context.js';
import { isSelfOrBotMessage, normalizeGatewayError, validateToken } from './lib/discord.js';
import {
  buildPairingNotification,
  loadPairingState,
  savePairingState,
  updatePairingState
} from './lib/dm-pairing.js';
import { handleUnauthorizedPairingDm } from './lib/dm-pairing-handler.js';
import {
  autoRegisterOwnerMentionedChannel,
  isBotMentioned,
  resolvePolicyChannelId,
  resolvePolicyThreadId
} from './lib/guild-access.js';
import {
  displayName,
  fetchIfPartial,
  getStickers,
  messageText,
  reactionEmoji,
  rememberMessageMetadata,
  resolveReplyContext,
  resolveMessageForDelete,
  resolveGuildMessageForwarding,
  shouldDownloadInboundMedia,
  shouldForwardMessageDelete,
  shouldForwardMessageUpdate,
  shouldForwardReaction,
  stickersNote
} from './lib/inbound.js';
import { downloadAttachment } from './lib/media.js';
import { clearReaction, setReaction, startTyping, stopAllTyping, stopTyping } from './lib/reactions.js';
import { recordIncoming, startRecordingServer, stopRecordingServer } from './lib/recording.js';
import { isVoiceMessageAttachment, resolveVoiceNote } from './lib/voice.js';

const LOG = '[discord]';
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

let client = null;
let configWatcherStop = null;
let shuttingDown = false;

async function main() {
  console.log(`${LOG} Starting...`);
  console.log(`${LOG} Data directory: ${DATA_DIR}`);

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
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`${LOG} gateway ready as ${readyClient.user.tag} (${readyClient.user.id})`);
  });

  client.on(Events.MessageCreate, (message) => {
    rememberMessageMetadata(message);
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

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    handleReactionEvent(reaction, user, 'added').catch((err) => {
      console.error(`${LOG} reaction add handler failed: ${err.message}`);
    });
  });

  client.on(Events.MessageReactionRemove, (reaction, user) => {
    handleReactionEvent(reaction, user, 'removed').catch((err) => {
      console.error(`${LOG} reaction remove handler failed: ${err.message}`);
    });
  });

  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    handleMessageUpdate(oldMessage, newMessage).catch((err) => {
      console.error(`${LOG} message update handler failed: ${err.message}`);
    });
  });

  client.on(Events.MessageDelete, (message) => {
    handleMessageDelete(message).catch((err) => {
      console.error(`${LOG} message delete handler failed: ${err.message}`);
    });
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

function resolveChannelName(config, message, policyChannelId, isThread) {
  const configuredName = config.channels?.[String(policyChannelId)]?.name;
  const parentName = configuredName || message.channel?.parent?.name || String(policyChannelId);
  if (!isThread) {
    return configuredName || message.channel?.name || String(policyChannelId);
  }

  const threadName = message.channel?.name;
  return threadName ? `${parentName} / ${threadName}` : parentName;
}

async function notifyOwnerChannelAutoRegistered({ ownerId, policyChannelId }) {
  try {
    const owner = await client.users.fetch(ownerId);
    await owner.send(`Auto-registered <#${policyChannelId}> as owner-only (mention mode). Use add-channel-allow to let others in.`);
  } catch (err) {
    console.warn(`${LOG} failed to notify owner about auto-registered channel: ${err.message}`);
  }
}

async function notifyOwnerDmPairingRequest({ userId, name, firstMessage }) {
  const ownerId = getConfig().owner;
  if (!ownerId) return;
  const notification = buildPairingNotification({ userId, name, firstMessage });

  try {
    const owner = await client.users.fetch(ownerId);
    await owner.send(notification);
  } catch (err) {
    console.warn(`${LOG} failed to notify owner about DM pairing request: ${err.message}`);
  }

  sendToC4('discord', 'admin|type:dm-pairing', notification, (notice) => {
    if (notice) console.warn(`${LOG} C4 did not take the DM pairing admin notice`);
  });
}

function getAttachments(message) {
  const attachments = message.attachments;
  if (!attachments) return [];
  if (typeof attachments.values === 'function') return [...attachments.values()];
  if (Array.isArray(attachments)) return attachments;
  return [];
}

function mediaMaxBytes(config) {
  const value = Number(config.media?.maxBytes);
  return Number.isFinite(value) && value > 0 ? value : 10 * 1024 * 1024;
}

function attachmentName(attachment) {
  return attachment?.name || 'file';
}

function skippedAttachmentNote(result, name = 'file') {
  const reason = result?.reason === 'too_large'
    ? 'too large'
    : (result?.reason ? result.reason.replace(/_/g, ' ') : 'download failed');
  return `[attachment skipped: ${reason}: ${name}]`;
}

function sentFileNote(name = 'file') {
  return `[sent a file: ${name}]`;
}

function appendNote(text, note) {
  const cleanText = String(text || '').trim();
  return cleanText ? `${cleanText} ${note}` : note;
}

function eventEndpoint(message, kind) {
  const channelId = message?.channel?.id;
  const messageId = message?.id;
  if (!channelId || !messageId) return null;
  return buildEventEndpoint(channelId, { messageId, kind, dm: !message.guild });
}

function sendDiscordEvent(message, kind, content) {
  const endpoint = eventEndpoint(message, kind);
  if (!endpoint) return false;
  sendToC4('discord', endpoint, content, (notice) => {
    if (notice) console.warn(`${LOG} C4 did not take the ${kind} event`);
  });
  return true;
}

async function resolveInboundMedia(config, attachment, { download, message = null } = {}) {
  if (!attachment) return { filePath: null, note: null };

  const name = attachmentName(attachment);
  if (!download) {
    return { filePath: null, note: `[attachment: ${name}]` };
  }

  try {
    const result = await downloadAttachment(attachment, { maxBytes: mediaMaxBytes(config) });
    if (result?.filePath) {
      const resolvedAttachment = { ...attachment, contentType: attachment.contentType || result.contentType };
      if (isVoiceMessageAttachment(resolvedAttachment, message)) {
        const voice = await resolveVoiceNote(resolvedAttachment, result.filePath, config);
        return { filePath: result.filePath, note: voice.note };
      }
      return { filePath: result.filePath, note: sentFileNote(result.name || name) };
    }
    return { filePath: null, note: skippedAttachmentNote(result, name) };
  } catch (err) {
    console.warn(`${LOG} failed to download attachment: ${err.message}`);
    return { filePath: null, note: `[attachment skipped: download failed: ${name}]` };
  }
}

export async function resolveInboundAttachments(config, attachments, {
  download,
  message = null,
  disabledNote = false,
  resolveMedia = resolveInboundMedia
} = {}) {
  if (!attachments.length) return { filePaths: [], note: null };

  const processed = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const skippedCount = Math.max(0, attachments.length - processed.length);
  const media = [];

  // Keep media and voice resolution sequential to avoid concurrent Whisper/download pressure.
  for (const attachment of processed) {
    if (disabledNote) {
      media.push({
        filePath: null,
        note: `[attachment skipped: media downloads disabled: ${attachmentName(attachment)}]`
      });
      continue;
    }
    media.push(await resolveMedia(config, attachment, { download, message }));
  }

  const notes = media.map((entry) => entry.note).filter(Boolean);
  if (skippedCount > 0) {
    notes.push(`[+${skippedCount} more attachments not processed]`);
  }

  return {
    filePaths: media.map((entry) => entry.filePath).filter(Boolean),
    note: notes.length ? notes.join(' ') : null
  };
}

async function handleReactionEvent(reaction, user, action) {
  const fetchedReaction = await fetchIfPartial(reaction, {
    kind: `reaction:${action}`,
    warn: (detail) => console.warn(`${LOG} ${detail}`)
  });
  if (!fetchedReaction?.message) return;
  const message = await fetchIfPartial(fetchedReaction.message, {
    kind: `reaction:${action}:message`,
    warn: (detail) => console.warn(`${LOG} ${detail}`)
  });
  if (!message?.channel) return;
  rememberMessageMetadata(message);

  const config = getConfig();
  const reactionForCheck = { emoji: fetchedReaction.emoji, message };
  if (!shouldForwardReaction({
    config,
    reaction: reactionForCheck,
    user,
    clientUserId: client.user?.id
  })) {
    return;
  }

  const content = formatReactionEvent({
    username: displayName(user),
    action,
    emoji: reactionEmoji(fetchedReaction),
    targetText: messageText(message) || '[no text]'
  });
  sendDiscordEvent(message, `reaction:${action}:${reactionEmoji(fetchedReaction)}:${user?.id || ''}`, content);
}

async function handleMessageUpdate(oldMessage, newMessage) {
  const fetchedNew = await fetchIfPartial(newMessage, {
    kind: 'message:update',
    warn: (detail) => console.warn(`${LOG} ${detail}`)
  });
  if (!fetchedNew?.channel) return;
  rememberMessageMetadata(fetchedNew);

  const config = getConfig();
  if (!shouldForwardMessageUpdate({
    config,
    oldMessage,
    newMessage: fetchedNew,
    clientUserId: client.user?.id
  })) {
    return;
  }

  const content = formatMessageEditEvent({
    username: displayName(fetchedNew.author || oldMessage?.author),
    newText: messageText(fetchedNew)
  });
  sendDiscordEvent(fetchedNew, 'edit', content);
}

async function handleMessageDelete(message) {
  const fetchedMessage = await resolveMessageForDelete(message, {
    warn: (detail) => console.warn(`${LOG} ${detail}`)
  });
  if (!fetchedMessage?.channel) return;

  const config = getConfig();
  if (!shouldForwardMessageDelete({
    config,
    message: fetchedMessage,
    clientUserId: client.user?.id
  })) {
    return;
  }

  const content = formatMessageDeleteEvent({
    username: displayName(fetchedMessage.author),
    text: messageText(fetchedMessage)
  });
  sendDiscordEvent(fetchedMessage, 'delete', content);
}

async function handleGuildMessage(message) {
  const config = getConfig();
  const isThread = message.channel?.isThread?.() || false;
  const policyChannelId = resolvePolicyChannelId(message);
  const threadId = resolvePolicyThreadId(message);
  const historyKey = message.channel.id;
  const attachments = getAttachments(message);
  const hasAttachment = attachments.length > 0;
  const stickers = getStickers(message);
  const hasSticker = stickers.length > 0;

  const userId = String(message.author.id);
  const mentioned = isBotMentioned(message, client.user);
  const autoRegister = await autoRegisterOwnerMentionedChannel({
    config,
    message,
    clientUser: client.user,
    saveConfig,
    updateConfig,
    notifyOwner: notifyOwnerChannelAutoRegistered
  });
  if (autoRegister.error === 'save_failed') {
    await message.reply('Internal error, please try again.').catch(() => {});
    return;
  }

  const access = resolveGuildAccess(config, policyChannelId, userId, threadId);
  if (!access.ok) return;

  const text = message.cleanContent || message.content || '';
  if (!text.trim() && !hasAttachment && !hasSticker) return;

  const forwarding = resolveGuildMessageForwarding({
    access,
    mentioned,
    text,
    hasAttachment,
    hasSticker
  });
  if (!forwarding.shouldForward) return;

  const correlationId = `${historyKey}:${message.id}`;
  if (forwarding.shouldRespond) {
    await setReaction(message);
    if (!forwarding.smartNoMention) {
      startTyping(message.channel, correlationId);
    }
  }

  const shouldDownloadMedia = shouldDownloadInboundMedia({
    shouldRespond: forwarding.shouldRespond,
    hasAttachment,
    downloadMediaEnabled: config.features?.downloadMedia !== false,
    smartNoMention: forwarding.smartNoMention
  });
  const media = hasAttachment && config.features?.downloadMedia === false && forwarding.shouldRespond
    ? await resolveInboundAttachments(config, attachments, { disabledNote: true })
    : (hasAttachment
        ? await resolveInboundAttachments(config, attachments, { download: shouldDownloadMedia, message })
        : { filePaths: [], note: null });
  const mediaNote = media.note;
  const stickerNote = stickersNote(stickers);
  const noteText = stickerNote ? appendNote(text, stickerNote) : text;
  const historyText = mediaNote ? appendNote(noteText, mediaNote) : noteText;
  if (!historyText.trim()) return;

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
      text: historyText,
      messageId: message.id
    });
  } catch (err) {
    console.warn(`${LOG} failed to record incoming guild message: ${err.message}`);
  }

  if (!forwarding.shouldRespond) return;

  const endpoint = buildEndpoint(historyKey, { messageId: message.id, correlationId });
  const channelName = resolveChannelName(config, message, policyChannelId, isThread);
  const history = getHistory(historyKey, message.id, limit);
  const replyingTo = await resolveReplyContext(message, {
    warn: (detail) => console.warn(`${LOG} ${detail}`)
  });

  const content = formatGroupMessage({
    channelName,
    username,
    text: historyText,
    history,
    isThread,
    smartHint: forwarding.smartNoMention,
    filePath: media.filePaths,
    replyingTo
  });

  sendToC4('discord', endpoint, content, async (notice) => {
    stopTyping(correlationId);
    await clearReaction(message);
    if (notice) await message.reply(notice).catch(() => {});
  });
}

async function handleDirectMessage(message) {
  let config = getConfig();
  const userId = String(message.author.id);
  const username = message.author.username || message.author.globalName || userId;
  const text = message.cleanContent || message.content || '';
  const attachments = getAttachments(message);
  const hasAttachment = attachments.length > 0;
  const stickers = getStickers(message);
  const hasSticker = stickers.length > 0;

  if (!hasOwner(config)) {
    const ownerUpdate = updateConfig((nextConfig) => {
      if (hasOwner(nextConfig)) return false;
      bindOwnerIfUnset(nextConfig, userId);
      return true;
    });
    if (!ownerUpdate.ok) {
      await message.reply('Internal error, please try again.').catch(() => {});
      return;
    }
    if (ownerUpdate.saved) {
      await message.reply('You are now the owner (admin) of this bot.').catch(() => {});
    }
  }

  config = getConfig();
  if (!isDmAuthorized(config, userId)) {
    const pairing = await handleUnauthorizedPairingDm({
      config,
      userId,
      name: username,
      channelId: message.channel.id,
      firstMessage: text,
      loadPairingState,
      savePairingState,
      updatePairingState,
      notifyOwner: notifyOwnerDmPairingRequest,
      reply: (replyText) => message.reply(replyText).catch(() => {})
    });
    if (pairing.handled) return;

    await message.reply('Sorry, this bot is private.').catch(() => {});
    return;
  }

  if (!text.trim() && !hasAttachment && !hasSticker) {
    await message.reply('Please send text or a file.').catch(() => {});
    return;
  }

  if (hasAttachment && config.features?.downloadMedia === false && !text.trim() && !hasSticker) {
    await message.reply('Media downloads are disabled. Please send text.').catch(() => {});
    return;
  }

  const correlationId = `${message.channel.id}:${message.id}`;
  await setReaction(message);
  startTyping(message.channel, correlationId);

  const media = hasAttachment && config.features?.downloadMedia !== false
    ? await resolveInboundAttachments(config, attachments, { download: true, message })
    : (hasAttachment ? await resolveInboundAttachments(config, attachments, { disabledNote: true }) : { filePaths: [], note: null });
  const mediaNote = media.note;
  const stickerNote = stickersNote(stickers);
  const noteText = stickerNote ? appendNote(text, stickerNote) : text;
  const historyText = mediaNote ? appendNote(noteText, mediaNote) : noteText;

  const endpoint = buildEndpoint(message.channel.id, { messageId: message.id, correlationId, dm: true });

  try {
    recordIncoming({
      channelId: message.channel.id,
      userId,
      username,
      text: historyText,
      messageId: message.id
    });
  } catch (err) {
    console.warn(`${LOG} failed to record incoming DM: ${err.message}`);
  }

  const replyingTo = await resolveReplyContext(message, {
    warn: (detail) => console.warn(`${LOG} ${detail}`)
  });
  const content = formatDmMessage({ username, text: historyText, filePath: media.filePaths, replyingTo });
  sendToC4('discord', endpoint, content, async (notice) => {
    stopTyping(correlationId);
    await clearReaction(message);
    if (notice) await message.reply(notice).catch(() => {});
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

// Boot the service unless we're being imported by the test runner (vitest sets VITEST=true),
// which lets tests import exported helpers without starting the bot.
// NOTE: do NOT gate on argv[1]/import.meta.url — PM2 fork mode sets argv[1] to its own
// container wrapper, so that check is false under PM2 and the bot would never start.
if (process.env.VITEST !== 'true') {
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));

  main().catch((err) => {
    console.error(`${LOG} Fatal error:`, err);
    process.exit(1);
  });
}
