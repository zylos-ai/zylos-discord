/**
 * Endpoint parsing, kept separate so c4.js and session-group.js do not import
 * each other.
 */
const ENDPOINT_KEYS = new Set(['msg', 'req', 'dm']);

export function parseEndpoint(endpoint) {
  const [channelId, ...parts] = String(endpoint || '').split('|');
  const result = { channelId, msg: null, req: null, dm: null };

  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = part.slice(0, colonIdx);
    if (!ENDPOINT_KEYS.has(key)) continue;
    result[key] = part.slice(colonIdx + 1);
  }

  return result;
}
