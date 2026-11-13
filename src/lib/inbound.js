import { isDmAuthorized, resolveGuildAccess } from './auth.js';
import { resolvePolicyChannelId, resolvePolicyThreadId } from './guild-access.js';
import { THINKING_REACTION } from './reactions.js';
import { buildEventEndpoint } from './c4.js';

/**
 * Endpoint for a reaction/edit/delete event. DM-ness comes from the channel
 * (the same check as the message path), not `message.guild`: the stand-in
 * built from cached metadata for an uncached deleted message has no `guild`.
 */
export function eventEndpoint(message, kind, opts = {}) {
  const channelId = message?.channel?.id;
  const messageId = message?.id;
  if (!channelId || !messageId) return null;
  return buildEventEndpoint(channelId, { ...opts, messageId, kind, dm: !!message.channel?.isDMBased?.() });
}

export const MAX_MESSAGE_METADATA_KEYS = 1000;

const messageMetadata = new Map();

function messageMetadataKey(channelId, messageId) {
  const safeChannelId = String(channelId || '');
  const safeMessageId = String(messageId || '');
  return safeChannelId && safeMessageId ? `${safeChannelId}:${safeMessageId}` : null;
}

function evictMessageMetadata(maxKeys = MAX_MESSAGE_METADATA_KEYS) {
  while (messageMetadata.size > maxKeys) {
    const oldestKey = messageMetadata.keys().next().value;
    if (oldestKey === undefined) break;
    messageMetadata.delete(oldestKey);
  }
}

function metadataToMessage(metadata) {
  const channel = {
    id: metadata.channelId,
    name: metadata.channelName,
    parentId: metadata.parentId,
    parent: metadata.parentName ? { name: metadata.parentName } : null,
    isDMBased: () => metadata.dm,
    isThread: () => metadata.thread
  };

  return {
    id: metadata.messageId,
    content: metadata.content,
    cleanContent: metadata.cleanContent,
    author: {
      id: metadata.userId,
      username: metadata.username,
      globalName: metadata.globalName,
      bot: metadata.bot
    },
    channel,
    inGuild: () => metadata.guild
  };
}

export function clearMessageMetadataCache() {
  messageMetadata.clear();
}

export function messageMetadataCount() {
  return messageMetadata.size;
}

export function rememberMessageMetadata(message, maxKeys = MAX_MESSAGE_METADATA_KEYS) {
  const channelId = message?.channel?.id;
  const messageId = message?.id;
  const userId = message?.author?.id;
  const key = messageMetadataKey(channelId, messageId);
  if (!key || !userId) return false;

  const isDm = !!message.channel?.isDMBased?.();
  const isThread = !!message.channel?.isThread?.();
  const inGuild = typeof message.inGuild === 'function' ? !!message.inGuild() : !isDm;

  if (messageMetadata.has(key)) messageMetadata.delete(key);
  messageMetadata.set(key, {
    channelId: String(channelId),
    messageId: String(messageId),
    userId: String(userId),
    username: message.author?.username || String(userId),
    globalName: message.author?.globalName || '',
    bot: !!message.author?.bot,
    content: String(message.content || ''),
    cleanContent: message.cleanContent == null ? null : String(message.cleanContent),
    dm: isDm,
    guild: inGuild,
    thread: isThread,
    parentId: message.channel?.parentId || null,
    channelName: message.channel?.name || '',
    parentName: message.channel?.parent?.name || ''
  });
  evictMessageMetadata(maxKeys);
  return true;
}

export function getCachedMessageMetadata(message) {
  const key = messageMetadataKey(message?.channel?.id, message?.id);
  const metadata = key ? messageMetadata.get(key) : null;
  if (!metadata) return null;
  messageMetadata.delete(key);
  messageMetadata.set(key, metadata);
  return metadataToMessage(metadata);
}

export async function resolveMessageForDelete(message, { fetchPartial = fetchIfPartial, warn = null } = {}) {
  const fetchedMessage = await fetchPartial(message);
  if (fetchedMessage?.channel) {
    rememberMessageMetadata(fetchedMessage);
    return fetchedMessage;
  }

  const cachedMessage = getCachedMessageMetadata(message);
  if (cachedMessage?.channel) {
    warn?.(`using cached metadata for deleted message ${message?.id || 'unknown'}`);
    return cachedMessage;
  }

  if (message?.partial) {
    warn?.(`failed to fetch partial deleted message ${message?.id || 'unknown'}`);
  }
  return null;
}

export function messageText(message) {
  return String(message?.cleanContent || message?.content || '');
}

export function getStickers(message) {
  const stickers = message?.stickers;
  if (!stickers) return [];
  if (typeof stickers.values === 'function') return [...stickers.values()];
  if (Array.isArray(stickers)) return stickers;
  return [];
}

export function stickerName(sticker) {
  return sticker?.name || sticker?.id || 'unknown';
}

export function stickersNote(stickers) {
  if (!stickers?.length) return null;
  const suffix = stickers.length > 1 ? ` [+${stickers.length - 1} more stickers]` : '';
  return `[sticker: ${stickerName(stickers[0])}]${suffix}`;
}

export function resolveGuildMessageForwarding({
  access,
  mentioned = false,
  text = '',
  hasAttachment = false,
  hasSticker = false
}) {
  const shouldRespond = !!(access?.smart || mentioned);
  const smartNoMention = !!(access?.smart && !mentioned);
  const mediaOnly = !String(text || '').trim() && (hasAttachment || hasSticker);

  return {
    shouldRespond,
    smartNoMention,
    shouldForward: !(mediaOnly && !shouldRespond)
  };
}

export function displayName(user) {
  return user?.username || user?.globalName || String(user?.id || 'unknown');
}

export function resolvePolicyChannelIdFromMessage(message) {
  return resolvePolicyChannelId(message);
}

export function isMessageAuthorized(config, message, userId) {
  if (!message?.channel || !userId) return false;
  if (message.channel.isDMBased?.()) {
    return isDmAuthorized(config, userId);
  }
  if (message.inGuild?.()) {
    const policyChannelId = resolvePolicyChannelIdFromMessage(message);
    return resolveGuildAccess(config, policyChannelId, userId, resolvePolicyThreadId(message)).ok;
  }
  return false;
}

export function shouldDownloadInboundMedia({
  shouldRespond,
  hasAttachment,
  downloadMediaEnabled = true,
  smartNoMention = false
}) {
  return !!shouldRespond && !!hasAttachment && downloadMediaEnabled !== false && !smartNoMention;
}

export async function fetchIfPartial(entity, { kind = 'partial', warn = null } = {}) {
  if (!entity?.partial) return entity;
  if (typeof entity.fetch !== 'function') return null;
  try {
    return await entity.fetch();
  } catch (err) {
    const id = entity?.id || entity?.message?.id || 'unknown';
    warn?.(`${kind} partial fetch failed id=${id}: ${err.message}`);
    return null;
  }
}

export async function resolveReplyContext(message, { warn = null } = {}) {
  if (!message?.reference || typeof message.fetchReference !== 'function') return null;
  try {
    const referenced = await message.fetchReference();
    if (!referenced?.id) return null;
    return {
      messageId: referenced.id,
      fromUserId: referenced.author?.id || '',
      text: messageText(referenced)
    };
  } catch (err) {
    warn?.(`reply reference fetch failed message=${message?.id || 'unknown'} reference=${message.reference?.messageId || 'unknown'}: ${err.message}`);
    return null;
  }
}

export function reactionEmoji(reaction) {
  return reaction?.emoji?.toString?.() || reaction?.emoji?.name || 'reaction';
}

export function reactionNotifyMode(config, message) {
  const policyChannelId = resolvePolicyChannelIdFromMessage(message);
  const channelMode = policyChannelId
    ? config.channels?.[String(policyChannelId)]?.reactionNotifyMode
    : null;
  return channelMode || config.reactionNotifyMode || 'own';
}

export function shouldForwardReaction({ config, reaction, user, clientUserId }) {
  const userId = String(user?.id || '');
  if (!userId || String(userId) === String(clientUserId)) return false;

  const emoji = reactionEmoji(reaction);
  if (emoji === THINKING_REACTION) return false;

  const mode = reactionNotifyMode(config, reaction?.message);
  if (mode === 'off') return false;
  if (mode === 'own' && String(reaction?.message?.author?.id || '') !== String(clientUserId)) {
    return false;
  }

  return isMessageAuthorized(config, reaction?.message, userId);
}

export function shouldForwardMessageUpdate({ config, oldMessage, newMessage, clientUserId }) {
  const author = newMessage?.author || oldMessage?.author;
  const userId = String(author?.id || '');
  if (!userId || author?.bot || String(userId) === String(clientUserId)) return false;

  const oldText = messageText(oldMessage);
  const newText = messageText(newMessage);
  if (oldText === newText) return false;
  if (!oldText && !newText) return false;

  return isMessageAuthorized(config, newMessage || oldMessage, userId);
}

export function shouldForwardMessageDelete({ config, message, clientUserId }) {
  const author = message?.author;
  const userId = String(author?.id || '');
  if (!userId || author?.bot || String(userId) === String(clientUserId)) return false;
  return isMessageAuthorized(config, message, userId);
}
