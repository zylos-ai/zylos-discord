/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules (fixed once live; changing them needs a migration):
 *   any Discord channel (DM, guild text channel, thread) -> channel-<channel id>
 *                                                           e.g. channel-1234567890123456789
 *   owner admin notices (endpoint "admin|...")            -> admin
 * Discord threads and forum posts are channels with their own id, so each one
 * is its own group; reply chains inside a channel stay in the channel's group.
 * The endpoint carries only the channel id, so DMs and guild channels share
 * one rule. The per-message `msg:` / `req:` parts never take part.
 * The component never adds a namespace; Core does.
 */
import { parseEndpoint } from './c4.js';

const CHANNEL_ID = /^[1-9]\d{0,24}$/;

/**
 * Derive the in-group session name from an endpoint string.
 * @param {string} endpoint - e.g. "1234567890|msg:42|req:..."
 * @returns {string} group name
 * @throws {Error} when the endpoint has no valid Discord channel id
 */
export function sessionGroupFromEndpoint(endpoint) {
  const channelId = String(parseEndpoint(endpoint).channelId ?? '').trim();
  if (channelId === 'admin') return 'admin';
  if (!CHANNEL_ID.test(channelId)) {
    throw new Error(`invalid Discord endpoint: ${JSON.stringify(String(endpoint ?? '').slice(0, 64))}`);
  }
  return `channel-${channelId}`;
}
