import { isOwner } from './auth.js';

export function resolvePolicyChannelId(message) {
  const isThread = message?.channel?.isThread?.() || false;
  return isThread ? (message.channel.parentId || message.channel.id) : message?.channel?.id;
}

export function resolvePolicyThreadId(message) {
  return message?.channel?.isThread?.() ? message.channel.id : null;
}

export function isBotMentioned(message, clientUser) {
  if (!clientUser) return false;
  if (message?.mentions?.has?.(clientUser)) return true;
  if (clientUser.id && message?.mentions?.users?.has?.(clientUser.id)) return true;
  return false;
}

export function resolvePolicyChannelName(message, policyChannelId) {
  const isThread = message?.channel?.isThread?.() || false;
  if (isThread) {
    return message.channel?.parent?.name || String(policyChannelId);
  }
  return message?.channel?.name || String(policyChannelId);
}

function ensureChannels(config) {
  if (!config.channels || typeof config.channels !== 'object' || Array.isArray(config.channels)) {
    config.channels = {};
  }
  return config.channels;
}

export async function autoRegisterOwnerMentionedChannel({
  config,
  message,
  clientUser,
  saveConfig,
  notifyOwner
}) {
  const userId = String(message?.author?.id || '');
  const policyChannelId = resolvePolicyChannelId(message);
  if (!policyChannelId || !isOwner(config, userId)) {
    return { registered: false };
  }

  const channels = ensureChannels(config);
  if (Object.prototype.hasOwnProperty.call(channels, String(policyChannelId))) {
    return { registered: false };
  }

  if (!isBotMentioned(message, clientUser)) {
    return { registered: false };
  }

  const channelName = resolvePolicyChannelName(message, policyChannelId);
  const nextChannel = {
    name: channelName,
    mode: 'mention',
    allowFrom: config.owner ? [String(config.owner)] : []
  };

  channels[String(policyChannelId)] = nextChannel;
  if (!saveConfig(config)) {
    delete channels[String(policyChannelId)];
    return { registered: false, error: 'save_failed' };
  }

  try {
    await notifyOwner?.({
      ownerId: String(config.owner || userId),
      policyChannelId: String(policyChannelId),
      channelName
    });
  } catch {
    return { registered: true, notified: false, policyChannelId: String(policyChannelId), channelName };
  }

  return { registered: true, notified: true, policyChannelId: String(policyChannelId), channelName };
}
