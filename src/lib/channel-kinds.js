/**
 * Persisted record of what kind of conversation each Discord channel id is.
 *
 * Discord ids do not tell a DM channel from a guild channel, and the endpoint
 * markers (`dm:1`) can be written by the agent, so neither can decide routing
 * or policy. This store is written only from facts the component observed
 * itself: an inbound message/event (discord.js knows the channel type) or a
 * Discord API channel lookup. A channel's kind never changes, so a record is
 * written once and kept.
 *
 * File: ~/zylos/components/discord/channel-kinds.json
 *   { "<channelId>": { "kind": "dm", "userId": "<recipient>" }
 *   | { "<channelId>": { "kind": "guild", "policyChannelId": "<parent or self>" } }
 * Shared by the service, scripts/send.js and scripts/session-group.js; writes
 * re-read the file, merge and replace it atomically.
 */
import fs from 'node:fs';
import path from 'node:path';

const KINDS = new Set(['dm', 'guild']);
let cache = null;
let cachePath = null;

export function channelKindsPath() {
  return path.join(process.env.HOME || '', 'zylos/components/discord/channel-kinds.json');
}

function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function load({ fresh = false } = {}) {
  const file = channelKindsPath();
  if (fresh || cache === null || cachePath !== file) {
    cache = readFile(file);
    cachePath = file;
  }
  return cache;
}

function validRecord(record) {
  return record && typeof record === 'object' && KINDS.has(record.kind) ? record : null;
}

/**
 * @param {string} channelId
 * @returns {{kind:'dm', userId?:string}|{kind:'guild', policyChannelId?:string}|null}
 */
export function getChannelKind(channelId) {
  const id = String(channelId ?? '');
  if (!id) return null;
  let record = validRecord(load()[id]);
  // Another process (the service, send.js) may have written it since.
  if (!record) record = validRecord(load({ fresh: true })[id]);
  return record;
}

/**
 * Remember a channel's kind. The first recorded kind wins: a later call with a
 * different kind is ignored and logged, so the session-group mapping derived
 * from it can never move. Missing detail (DM user id, thread parent) is filled in.
 * @returns {boolean} whether the file was written
 */
export function recordChannelKind(channelId, kind, extra = {}) {
  const id = String(channelId ?? '');
  if (!id || !KINDS.has(kind)) return false;
  const current = getChannelKind(id);
  const detail = Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
  if (current) {
    if (current.kind !== kind) {
      console.warn(`[discord] channel ${id} already recorded as ${current.kind}, ignoring ${kind}`);
      return false;
    }
    if (Object.entries(detail).every(([k, v]) => current[k] === v)) return false;
  }
  const file = channelKindsPath();
  const data = readFile(file);
  const existing = validRecord(data[id]);
  if (existing && existing.kind !== kind) return false;
  data[id] = { ...(existing || {}), kind, ...detail };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[discord] cannot record channel kind for ${id}: ${err.message}`);
    cache = null;
    return false;
  }
  cache = data;
  cachePath = file;
  return true;
}

/** Record from a discord.js message/channel object the component received. */
export function recordChannelFromMessage(message) {
  const channel = message?.channel;
  if (!channel?.id) return false;
  if (channel.isDMBased?.()) {
    return recordChannelKind(channel.id, 'dm', { userId: message.author?.id && !message.author?.bot ? message.author.id : null });
  }
  const isThread = channel.isThread?.() === true;
  return recordChannelKind(channel.id, 'guild', { policyChannelId: isThread ? (channel.parentId || channel.id) : channel.id });
}

/** Test hook. */
export function resetChannelKindsCache() {
  cache = null;
  cachePath = null;
}
