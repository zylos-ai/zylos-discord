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
  updateConfig,
  notifyOwner
}) {
  const userId = String(message?.author?.id || '');
  const policyChannelId = resolvePolicyChannelId(message);
  if (!policyChannelId) {
    return { registered: false };
  }

  if (updateConfig) {
    let registration = null;
    const updated = updateConfig((nextConfig) => {
      if (!policyChannelId || !isOwner(nextConfig, userId)) return false;
      // Disabled guild policy rejects the owner too; do not register channels.
      if (nextConfig.groupPolicy === 'disabled') return false;
      const channels = ensureChannels(nextConfig);
      if (Object.prototype.hasOwnProperty.call(channels, String(policyChannelId))) return false;
      if (!isBotMentioned(message, clientUser)) return false;
      const channelName = resolvePolicyChannelName(message, policyChannelId);
      channels[String(policyChannelId)] = {
        name: channelName,
        mode: 'mention',
        allowFrom: nextConfig.owner ? [String(nextConfig.owner)] : []
      };
      registration = {
        policyChannelId: String(policyChannelId),
        channelName,
        ownerId: String(nextConfig.owner || userId)
      };
      return true;
    });

    if (!updated.ok) {
      return { registered: false, error: 'save_failed' };
    }
    if (!registration) {
      return { registered: false };
    }
    try {
      await notifyOwner?.(registration);
    } catch {
      return { registered: true, notified: false, ...registration };
    }
    return { registered: true, notified: true, ...registration };
  }

  if (!isOwner(config, userId) || config.groupPolicy === 'disabled') {
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
