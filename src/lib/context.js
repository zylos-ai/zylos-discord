import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LOG_DIR = path.join(DATA_DIR, 'logs', 'dm');
const DEFAULT_HISTORY_LIMIT = 5;
const MAX_RING_ENTRIES = 100;

const replayedKeys = new Set();
const historyRings = new Map();

function safeLogName(channelId) {
  return String(channelId || '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}

function logPathFor(historyKey) {
  return path.join(LOG_DIR, `${safeLogName(historyKey)}.jsonl`);
}

function normalizeLimit(limit) {
  const value = Number(limit);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_HISTORY_LIMIT;
}

function normalizeEntry(entry = {}) {
  if (typeof entry.text !== 'string' || !entry.text.trim()) return null;
  return {
    direction: entry.direction === 'out' ? 'out' : 'in',
    username: entry.username || (entry.direction === 'out' ? 'bot' : entry.userId || 'user'),
    text: entry.text,
    messageId: entry.messageId ? String(entry.messageId) : null
  };
}

function setRing(historyKey, entries, limit = MAX_RING_ENTRIES) {
  const normalizedLimit = Math.min(normalizeLimit(limit), MAX_RING_ENTRIES);
  historyRings.set(String(historyKey), entries.slice(-normalizedLimit));
}

export function channelHistoryLimit(config, policyChannelId) {
  const channel = (config.channels || {})[String(policyChannelId)];
  return normalizeLimit(channel?.historyLimit || config.historyLimit);
}

export function appendToRing(historyKey, entry, limit = MAX_RING_ENTRIES) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return false;

  const key = String(historyKey);
  const ring = historyRings.get(key) || [];
  ring.push(normalized);
  setRing(key, ring, Math.max(normalizeLimit(limit), ring.length));
  return true;
}

export function ensureReplay(historyKey, limit = DEFAULT_HISTORY_LIMIT) {
  const key = String(historyKey);
  if (replayedKeys.has(key)) return true;

  try {
    const filePath = logPathFor(key);
    if (!fs.existsSync(filePath)) {
      replayedKeys.add(key);
      if (!historyRings.has(key)) historyRings.set(key, []);
      return true;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const entries = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.warn(`[discord] skipping malformed log line in ${key}`);
        continue;
      }
      const normalized = normalizeEntry(parsed);
      if (normalized) entries.push(normalized);
    }

    setRing(key, entries, limit);
    replayedKeys.add(key);
    return true;
  } catch {
    return false;
  }
}

export function getHistory(historyKey, beforeMessageId, limit = DEFAULT_HISTORY_LIMIT) {
  const key = String(historyKey);
  const ring = historyRings.get(key) || [];
  const before = beforeMessageId ? String(beforeMessageId) : null;
  const endIndex = before ? ring.findIndex((entry) => entry.messageId === before) : -1;
  const source = endIndex >= 0
    ? ring.slice(0, endIndex)
    : (before ? ring.filter((entry) => entry.messageId !== before) : ring);
  return source.slice(-normalizeLimit(limit));
}

export function resetContextForTests() {
  replayedKeys.clear();
  historyRings.clear();
}
