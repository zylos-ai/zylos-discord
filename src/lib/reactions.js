import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const THINKING_REACTION = '💡';

const TYPING_DIR = path.join(DATA_DIR, 'typing');
const TYPING_TIMEOUT_MS = 120 * 1000;
const TYPING_INTERVAL_MS = 8000;
const activeTyping = new Map();
const pendingThinking = new Map();

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

function doneFilePath(correlationId) {
  const safe = safeCorrelationId(correlationId);
  return safe ? path.join(TYPING_DIR, `${safe}.done`) : null;
}

function unlinkDoneFile(correlationId) {
  const filePath = doneFilePath(correlationId);
  if (!filePath) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sweepTypingDoneFiles(maxAgeMs = TYPING_TIMEOUT_MS, now = Date.now()) {
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(TYPING_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.done')) continue;
      const filePath = path.join(TYPING_DIR, entry.name);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      fs.unlinkSync(filePath);
      removed += 1;
    }
  } catch {}
  return removed;
}

function pendingChannelId(message) {
  return String(message?.channel?.id || message?.channelId || '');
}

function pendingMessageId(message) {
  return String(message?.id || '');
}

export function trackThinkingReaction(message) {
  const channelId = pendingChannelId(message);
  const messageId = pendingMessageId(message);
  if (!channelId || !messageId) return false;

  let channelPending = pendingThinking.get(channelId);
  if (!channelPending) {
    channelPending = new Map();
    pendingThinking.set(channelId, channelPending);
  }
  channelPending.set(messageId, message);
  return true;
}

export function untrackThinkingReaction(message) {
  const channelId = pendingChannelId(message);
  const messageId = pendingMessageId(message);
  const channelPending = channelId ? pendingThinking.get(channelId) : null;
  if (!channelPending || !messageId) return false;

  const deleted = channelPending.delete(messageId);
  if (channelPending.size === 0) {
    pendingThinking.delete(channelId);
  }
  return deleted;
}

export function pendingThinkingCount(channelId) {
  return pendingThinking.get(String(channelId))?.size || 0;
}

export async function clearThinkingReaction(channelId, messageId, emoji = THINKING_REACTION) {
  const safeChannelId = String(channelId || '');
  const safeMessageId = String(messageId || '');
  const channelPending = pendingThinking.get(safeChannelId);
  const message = channelPending?.get(safeMessageId);
  if (!message) {
    return { attempted: 0, cleared: 0 };
  }

  const cleared = await clearReaction(message, emoji);
  return { attempted: 1, cleared: cleared ? 1 : 0 };
}

export async function clearThinkingReactionsForChannel(channelId, emoji = THINKING_REACTION) {
  const safeChannelId = String(channelId || '');
  const channelPending = pendingThinking.get(safeChannelId);
  if (!channelPending) {
    return { attempted: 0, cleared: 0 };
  }

  const messages = [...channelPending.values()];
  pendingThinking.delete(safeChannelId);

  let cleared = 0;
  for (const message of messages) {
    if (await clearReaction(message, emoji)) {
      cleared += 1;
    }
  }

  return { attempted: messages.length, cleared };
}

function doneFileExists(correlationId) {
  const filePath = doneFilePath(correlationId);
  return !!filePath && fs.existsSync(filePath);
}

export async function setReaction(message, emoji = THINKING_REACTION) {
  try {
    await message.react(emoji);
    if (emoji === THINKING_REACTION) {
      trackThinkingReaction(message);
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearReaction(message, emoji = THINKING_REACTION) {
  try {
    const reaction = message.reactions?.cache?.get(emoji);
    await reaction?.users?.remove(message.client?.user?.id);
    if (emoji === THINKING_REACTION) {
      untrackThinkingReaction(message);
    }
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
  sweepTypingDoneFiles();

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
  unlinkDoneFile(safe);

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

sweepTypingDoneFiles();
