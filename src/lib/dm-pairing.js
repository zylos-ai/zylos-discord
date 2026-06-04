/**
 * DM pairing state for zylos-discord.
 *
 * Unknown DM senders under `dmPolicy: "pairing"` are queued for owner
 * approval. The agent never auto-approves; approval adds the user to
 * dmAllowFrom via the admin CLI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, withStateLock } from './config.js';

export const PAIRING_STATE_FILE = path.join(DATA_DIR, 'dm-pairing.json');
const FIRST_MESSAGE_LIMIT = 500;

export class PairingStateLoadError extends Error {
  constructor(message, { filePath, cause } = {}) {
    super(message);
    this.name = 'PairingStateLoadError';
    this.filePath = filePath;
    this.cause = cause;
  }
}

function normalizeUserId(userId) {
  return String(userId || '').trim();
}

function truncateFirstMessage(value) {
  return String(value || '').slice(0, FIRST_MESSAGE_LIMIT);
}

function normalizeState(parsed = {}) {
  return {
    pending: parsed.pending && typeof parsed.pending === 'object' && !Array.isArray(parsed.pending)
      ? parsed.pending
      : {},
    denied: parsed.denied && typeof parsed.denied === 'object' && !Array.isArray(parsed.denied)
      ? parsed.denied
      : {}
  };
}

export function loadPairingState(filePath = PAIRING_STATE_FILE) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { pending: {}, denied: {} };
    }
    throw new PairingStateLoadError(`failed to load pairing state: ${err.message}`, {
      filePath,
      cause: err
    });
  }
}

export function savePairingState(state, filePath = PAIRING_STATE_FILE) {
  return withStateLock(() => writePairingStateFile(state, filePath));
}

function writePairingStateFile(state, filePath = PAIRING_STATE_FILE) {
  const payload = normalizeState(state);
  const tmpPath = filePath + '.tmp';
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
    return true;
  } catch (err) {
    console.error(`[discord] Failed to save pairing state: ${err.message}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  }
}

export function updatePairingState(mutator, filePath = PAIRING_STATE_FILE) {
  return withStateLock(() => {
    const state = loadPairingState(filePath);
    const result = mutator(state);
    if (result === false) {
      return { ok: true, saved: false, state, result };
    }
    if (!writePairingStateFile(state, filePath)) {
      return { ok: false, saved: false, state, result };
    }
    return { ok: true, saved: true, state, result };
  });
}

export function listPendingPairing(state = loadPairingState()) {
  return Object.values(normalizeState(state).pending);
}

export function getPairingStatus(state, userId, config = null) {
  const id = normalizeUserId(userId);
  if (!id) return 'new';
  if ((config?.dmAllowFrom || []).map(String).includes(id)) return 'approved';
  const normalized = normalizeState(state);
  if (normalized.denied[id]) return 'denied';
  if (normalized.pending[id]) return 'pending';
  return 'new';
}

export function markPairingPending({ userId, name, channelId, firstMessage }, state = loadPairingState()) {
  const id = normalizeUserId(userId);
  if (!id) return false;
  const normalized = normalizeState(state);
  state.pending = normalized.pending;
  state.denied = normalized.denied;

  if (state.pending[id] || state.denied[id]) return false;

  state.pending[id] = {
    userId: id,
    name: String(name || 'unknown'),
    channelId: String(channelId || ''),
    firstMessage: truncateFirstMessage(firstMessage),
    requestedAt: new Date().toISOString()
  };
  return true;
}

export function approvePairingUser(config, userId, state = loadPairingState()) {
  const id = normalizeUserId(userId);
  if (!id) return false;
  if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
  const allow = config.dmAllowFrom.map(String);
  if (!allow.includes(id)) config.dmAllowFrom.push(id);

  const normalized = normalizeState(state);
  state.pending = normalized.pending;
  state.denied = normalized.denied;
  delete state.pending[id];
  delete state.denied[id];
  return true;
}

export function denyPairingUser(config, userId, reason = '', state = loadPairingState()) {
  const id = normalizeUserId(userId);
  if (!id) return false;
  const normalized = normalizeState(state);
  state.pending = normalized.pending;
  state.denied = normalized.denied;

  state.denied[id] = {
    userId: id,
    deniedAt: new Date().toISOString(),
    reason: String(reason || '').trim()
  };
  delete state.pending[id];
  if (Array.isArray(config.dmAllowFrom)) {
    config.dmAllowFrom = config.dmAllowFrom.filter((entry) => String(entry) !== id);
  }
  return true;
}

export function buildPairingNotification({ userId, name, firstMessage }) {
  const text = truncateFirstMessage(firstMessage).replace(/\s+/g, ' ').trim();
  return [
    `DM pairing request from ${name || 'unknown'} (${userId}).`,
    `First message: "${text}"`,
    `Approve: admin dm-approve ${userId} - Deny: admin dm-deny ${userId}.`
  ].join('\n');
}
