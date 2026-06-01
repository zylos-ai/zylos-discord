import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const THINKING_REACTION = '👀';

const TYPING_DIR = path.join(DATA_DIR, 'typing');
const TYPING_TIMEOUT_MS = 120 * 1000;
const TYPING_INTERVAL_MS = 8000;
const activeTyping = new Map();

export function safeCorrelationId(raw) {
  if (!raw) return null;
  const value = String(raw);
  return /^[A-Za-z0-9_:-]+$/.test(value) ? value : null;
}

export function markTypingDone(correlationId) {
  const safe = safeCorrelationId(correlationId);
  if (!safe) return false;

  try {
    fs.mkdirSync(TYPING_DIR, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(TYPING_DIR, 0o700);
    } catch {}
    fs.writeFileSync(path.join(TYPING_DIR, `${safe}.done`), `${Date.now()}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function doneFileExists(correlationId) {
  const safe = safeCorrelationId(correlationId);
  return !!safe && fs.existsSync(path.join(TYPING_DIR, `${safe}.done`));
}

export async function setReaction(message, emoji = THINKING_REACTION) {
  try {
    await message.react(emoji);
    return true;
  } catch {
    return false;
  }
}

export async function clearReaction(message, emoji = THINKING_REACTION) {
  try {
    const reaction = message.reactions?.cache?.get(emoji);
    await reaction?.users?.remove(message.client?.user?.id);
    return true;
  } catch {
    return false;
  }
}

export function startTyping(channel, correlationId) {
  const safe = safeCorrelationId(correlationId);
  if (!safe || activeTyping.has(safe)) return false;

  try {
    fs.mkdirSync(TYPING_DIR, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(TYPING_DIR, 0o700);
    } catch {}
  } catch {}

  channel.sendTyping().catch(() => {});

  const interval = setInterval(() => {
    if (doneFileExists(safe)) {
      stopTyping(safe);
      return;
    }
    channel.sendTyping().catch(() => {});
  }, TYPING_INTERVAL_MS);

  const timeout = setTimeout(() => {
    stopTyping(safe);
  }, TYPING_TIMEOUT_MS);

  activeTyping.set(safe, { interval, timeout });
  return true;
}

export function stopTyping(correlationId) {
  const safe = safeCorrelationId(correlationId);
  if (!safe) return false;

  const entry = activeTyping.get(safe);
  if (!entry) return false;
  clearInterval(entry.interval);
  clearTimeout(entry.timeout);
  activeTyping.delete(safe);
  return true;
}

export function stopAllTyping() {
  for (const correlationId of activeTyping.keys()) {
    stopTyping(correlationId);
  }
}

export function activeTypingCount() {
  return activeTyping.size;
}
