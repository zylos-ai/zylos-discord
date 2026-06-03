import { isDmAuthorized, resolveGuildAccess } from './auth.js';
import { THINKING_REACTION } from './reactions.js';

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

export function displayName(user) {
  return user?.username || user?.globalName || String(user?.id || 'unknown');
}

export function resolvePolicyChannelIdFromMessage(message) {
  const isThread = message?.channel?.isThread?.() || false;
  return isThread ? (message.channel.parentId || message.channel.id) : message?.channel?.id;
}

export function isMessageAuthorized(config, message, userId) {
  if (!message?.channel || !userId) return false;
  if (message.channel.isDMBased?.()) {
    return isDmAuthorized(config, userId);
  }
  if (message.inGuild?.()) {
    const policyChannelId = resolvePolicyChannelIdFromMessage(message);
    return resolveGuildAccess(config, policyChannelId, userId).ok;
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

export async function fetchIfPartial(entity) {
  if (!entity?.partial) return entity;
  if (typeof entity.fetch !== 'function') return null;
  try {
    return await entity.fetch();
  } catch {
    return null;
  }
}

export async function resolveReplyContext(message) {
  if (!message?.reference || typeof message.fetchReference !== 'function') return null;
  try {
    const referenced = await message.fetchReference();
    if (!referenced?.id) return null;
    return {
      messageId: referenced.id,
      fromUserId: referenced.author?.id || '',
      text: messageText(referenced)
    };
  } catch {
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
