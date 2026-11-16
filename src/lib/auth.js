export function isOwner(config, userId) {
  return !!config.owner && String(config.owner) === String(userId);
}

export function hasOwner(config) {
  return !!config.owner;
}

export function bindOwnerIfUnset(config, userId) {
  if (config.owner) return false;
  config.owner = String(userId);
  return true;
}

export function isDmAuthorized(config, userId) {
  if (isOwner(config, userId)) return true;

  switch (config.dmPolicy) {
    case 'open':
      return true;
    case 'allowlist':
    case 'pairing':
      return (config.dmAllowFrom || []).map(String).includes(String(userId));
    case 'owner':
    default:
      return false;
  }
}

export function isChannelAllowed(config, policyChannelId) {
  if (config.groupPolicy === 'disabled') return false;
  if (config.groupPolicy === 'open') return true;
  return Object.prototype.hasOwnProperty.call(config.channels || {}, String(policyChannelId));
}

export function isSmartChannel(config, policyChannelId, threadId = null) {
  if (config.groupPolicy === 'disabled') return false;
  const channel = (config.channels || {})[String(policyChannelId)];
  const thread = threadId ? channel?.threads?.[String(threadId)] : null;
  return (thread?.mode || channel?.mode) === 'smart';
}

export function isSenderAllowed(config, policyChannelId, userId) {
  const channel = (config.channels || {})[String(policyChannelId)];
  const allowFrom = (channel?.allowFrom || []).map(String);
  return allowFrom.length === 0 || allowFrom.includes('*') || allowFrom.includes(String(userId));
}

export function resolveGuildAccess(config, policyChannelId, userId, threadId = null) {
  const owner = isOwner(config, userId);
  // groupPolicy=disabled rejects everyone, the owner included (same as Telegram).
  if (config.groupPolicy === 'disabled') {
    return { ok: false, owner, allowed: false, smart: false };
  }
  const allowed = isChannelAllowed(config, policyChannelId);
  const smart = isSmartChannel(config, policyChannelId, threadId);

  if (!owner && !allowed && !smart) {
    return { ok: false, owner, allowed, smart };
  }

  if (!owner && !isSenderAllowed(config, policyChannelId, userId)) {
    return { ok: false, owner, allowed, smart };
  }

  return { ok: true, owner, allowed, smart };
}
