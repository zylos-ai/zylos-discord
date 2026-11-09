/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules (fixed once live; changing them needs a migration):
 *   DM channel (endpoint carries dm:1)       -> dm-<channel id>       e.g. dm-1234567890123456789
 *   guild text channel, thread, forum post   -> channel-<channel id>  e.g. channel-987654321098765432
 *   owner admin notices (endpoint "admin|...") -> admin
 * Discord threads and forum posts are channels with their own id, so each one
 * is its own group; reply chains inside a channel stay in the channel's group.
 * DMs are marked on the endpoint at build time (`dm:1`, like Telegram's
 * `topic:`), so no state is stored. The per-message `msg:` / `req:` parts never
 * take part.
 * The component never adds a namespace; Core does.
 */
import { parseEndpoint } from './c4.js';

const CHANNEL_ID = /^[1-9]\d{0,24}$/;
const SESSION_GROUP = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * Core's session-group name contract (zylos-core c4-session-group.js): at most
 * 95 characters, `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`, case-sensitive. Core
 * validates again; this lets tests and callers check locally.
 */
export function isValidSessionGroup(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 95 && SESSION_GROUP.test(name);
}

/**
 * Derive the in-group session name from an endpoint string.
 * @param {string} endpoint - e.g. "1234567890|msg:42|req:..."
 * @returns {string} group name
 * @throws {Error} when the endpoint has no valid Discord channel id
 */
export function sessionGroupFromEndpoint(endpoint) {
  const parsed = parseEndpoint(endpoint);
  const channelId = String(parsed.channelId ?? '').trim();
  if (channelId === 'admin') return 'admin';
  if (!CHANNEL_ID.test(channelId)) {
    throw new Error(`invalid Discord endpoint: ${JSON.stringify(String(endpoint ?? '').slice(0, 64))}`);
  }
  if (parsed.dm !== null && parsed.dm !== '1') {
    throw new Error(`invalid dm marker in endpoint: ${JSON.stringify(String(parsed.dm).slice(0, 16))}`);
  }
  return parsed.dm === '1' ? `dm-${channelId}` : `channel-${channelId}`;
}
