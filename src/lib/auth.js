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
      return (config.dmAllowFrom || []).map(String).includes(String(userId));
    case 'owner':
    default:
      return false;
  }
}
