/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * Rules (fixed once live; changing them needs a migration):
 *   DM channel                               -> dm-<channel id>       e.g. dm-1234567890123456789
 *   guild text channel, thread, forum post   -> channel-<channel id>  e.g. channel-987654321098765432
 *   owner admin notices (endpoint "admin|...") -> admin
 * Discord threads and forum posts are channels with their own id, so each one
 * is its own group; reply chains inside a channel stay in the channel's group.
 * The per-message `msg:` / `req:` parts never take part.
 *
 * DM vs guild is decided from the channel's real type, never from the
 * endpoint's `dm:1` marker (an endpoint can be written by the agent, and
 * pre-upgrade endpoints have no marker): the component records each channel's
 * kind when it receives from it (channel-kinds.js), and
 * scripts/session-group.js asks the Discord API for channels it has not seen.
 * A channel whose kind cannot be established is an unknown conversation:
 * lookup fails (exit 1) instead of guessing. Core 1.0.0-beta.8 calls the script
 * on every outbound send and the scheduler stores the answer, so a wrong guess
 * would be permanent.
 * The component never adds a namespace; Core does.
 */
import { parseEndpoint } from './endpoint.js';
import { getChannelKind, recordChannelKind } from './channel-kinds.js';

const CHANNEL_ID = /^[1-9]\d{0,24}$/;
const SESSION_GROUP = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
// Discord channel types: https://discord.com/developers/docs/resources/channel
const DM = 1;
const GROUP_DM = 3;
const THREAD_TYPES = new Set([10, 11, 12]);
const LOOKUP_TIMEOUT_MS = 4000; // Core gives the lookup script 5 s

/**
 * Core's session-group name contract (zylos-core c4-session-group.js): at most
 * 95 characters, `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`, case-sensitive. Core
 * validates again; this lets tests and callers check locally.
 */
export function isValidSessionGroup(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 95 && SESSION_GROUP.test(name);
}

export class UnknownConversationError extends Error {}

function parseChecked(endpoint) {
  const parsed = parseEndpoint(endpoint);
  const channelId = String(parsed.channelId ?? '').trim();
  if (channelId === 'admin') return { channelId };
  if (!CHANNEL_ID.test(channelId)) {
    throw new Error(`invalid Discord endpoint: ${JSON.stringify(String(endpoint ?? '').slice(0, 64))}`);
  }
  if (parsed.dm !== null && parsed.dm !== '1') {
    throw new Error(`invalid dm marker in endpoint: ${JSON.stringify(String(parsed.dm).slice(0, 16))}`);
  }
  return { channelId };
}

/**
 * Derive the in-group session name from an endpoint, using the recorded
 * channel kind.
 * @param {string} endpoint - e.g. "1234567890|msg:42|req:..."
 * @param {object} [opts]
 * @param {function} [opts.kindOf] - channelId -> record|null (tests)
 * @returns {string} group name
 * @throws {Error} invalid endpoint; UnknownConversationError when the channel's kind is not known
 */
export function sessionGroupFromEndpoint(endpoint, { kindOf = getChannelKind } = {}) {
  const { channelId } = parseChecked(endpoint);
  if (channelId === 'admin') return 'admin';
  const record = kindOf(channelId);
  if (record?.kind === 'dm') return `dm-${channelId}`;
  if (record?.kind === 'guild') return `channel-${channelId}`;
  throw new UnknownConversationError(`unknown Discord conversation ${channelId} (not seen by this bot)`);
}

/** GET /channels/{id} with a timeout; resolves to the channel JSON. */
export async function fetchDiscordChannel(channelId, { token, apiBase = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10', timeoutMs = LOOKUP_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('no bot token');
  const res = await fetchImpl(`${apiBase}/channels/${channelId}`, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`Discord API ${res.status}`);
  return await res.json();
}

/** Record a channel's kind from a Discord API channel object. */
export function recordChannelFromApi(channel) {
  if (!channel?.id || typeof channel.type !== 'number' || channel.type === GROUP_DM) return false;
  if (channel.type === DM) return recordChannelKind(channel.id, 'dm', { userId: channel.recipients?.[0]?.id });
  return recordChannelKind(channel.id, 'guild', {
    policyChannelId: THREAD_TYPES.has(channel.type) ? (channel.parent_id || channel.id) : channel.id
  });
}

/**
 * Like sessionGroupFromEndpoint, but for a channel the component has not
 * recorded it asks the Discord API once and records the answer.
 * @param {string} endpoint
 * @param {object} [opts]
 * @param {function} [opts.lookup] - async channelId -> Discord channel object
 */
export async function resolveSessionGroup(endpoint, { lookup } = {}) {
  try {
    return sessionGroupFromEndpoint(endpoint);
  } catch (err) {
    if (!(err instanceof UnknownConversationError)) throw err;
  }
  const { channelId } = parseChecked(endpoint);
  let channel;
  try {
    channel = await lookup(channelId);
  } catch (err) {
    throw new UnknownConversationError(`unknown Discord conversation ${channelId} (channel lookup failed: ${err.message})`);
  }
  if (String(channel?.id) !== channelId || typeof channel?.type !== 'number') {
    throw new UnknownConversationError(`unknown Discord conversation ${channelId} (unexpected channel lookup result)`);
  }
  if (channel.type === GROUP_DM) throw new UnknownConversationError(`group DM ${channelId} is not supported`);
  recordChannelFromApi(channel);
  // Use the stored record so the answer matches what is persisted.
  return sessionGroupFromEndpoint(endpoint, {
    kindOf: (id) => getChannelKind(id) || { kind: channel.type === DM ? 'dm' : 'guild' }
  });
}
