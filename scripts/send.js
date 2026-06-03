#!/usr/bin/env node
/**
 * C4 Communication Bridge Interface for zylos-discord.
 *
 * Usage:
 *   node scripts/send.js <endpoint_id> "message text"
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { getBotToken, getConfig } from '../src/lib/config.js';
import { parseEndpoint } from '../src/lib/c4.js';
import { markTypingDone, safeCorrelationId, THINKING_REACTION } from '../src/lib/reactions.js';
import { getInternalToken } from '../src/lib/recording.js';

const API = 'https://discord.com/api/v10';
const MAX_LENGTH = 2000;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const CHUNK_DELAY_MS = 400;
const IS_DIRECT = process.argv[1] === fileURLToPath(import.meta.url);

const args = process.argv.slice(2);
if (IS_DIRECT && args.length < 2) {
  console.error('Usage: send.js <endpoint_id> <message>');
  process.exit(1);
}

const endpoint = parseEndpoint(args[0]);
const message = args.slice(1).join(' ');
const correlationId = safeCorrelationId(endpoint.req);

if (IS_DIRECT && !endpoint.channelId) {
  console.error('Error: invalid endpoint (missing channelId)');
  process.exit(1);
}

if (IS_DIRECT && endpoint.req && !correlationId) {
  console.error('Error: invalid endpoint (unsafe req)');
  process.exit(1);
}

let cachedBotToken = null;

function getResolvedBotToken() {
  if (cachedBotToken === null) {
    cachedBotToken = getBotToken();
  }
  return cachedBotToken;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function splitMessage(text, maxLen = MAX_LENGTH) {
  const input = String(text || '');
  if (input.length <= maxLen) return input.trim() ? [input] : [];

  const chunks = [];
  let remaining = input;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      const finalChunk = remaining.trim();
      if (finalChunk) chunks.push(finalChunk);
      break;
    }

    let breakAt = maxLen;
    const chunk = remaining.slice(0, breakAt);
    const lastParaBreak = chunk.lastIndexOf('\n\n');
    if (lastParaBreak > maxLen * 0.3) breakAt = lastParaBreak + 1;
    else {
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline > maxLen * 0.3) breakAt = lastNewline;
      else {
        const lastSpace = chunk.lastIndexOf(' ');
        if (lastSpace > maxLen * 0.3) breakAt = lastSpace;
      }
    }

    const part = remaining.slice(0, breakAt).trim();
    remaining = remaining.slice(breakAt).trim();
    if (part) chunks.push(part);
  }

  return chunks;
}

export function parseMediaMessage(text) {
  const match = String(text || '').match(/^\[MEDIA:(image|file)](.+)$/);
  if (!match) return null;
  const filePath = match[2].trim();
  if (!filePath) return null;
  return { kind: match[1], filePath };
}

export function validateMediaFile(filePath, maxBytes = MAX_MEDIA_BYTES) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error('media path is not a file');
  }
  if (stat.size > maxBytes) {
    throw new Error('file exceeds 10MB');
  }
  return stat;
}

async function discordRequest(url, options, { maxRetries = 2 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status === 429 && attempt < maxRetries) {
      let retryAfter = 1;
      try {
        const body = await res.json();
        retryAfter = Number(body.retry_after || retryAfter);
      } catch {}
      await sleep(Math.ceil(retryAfter * 1000));
      continue;
    }
    return res;
  }
}

async function sendDiscordMessage(content, { replyToId } = {}) {
  const botToken = getResolvedBotToken();
  const body = {
    content,
    allowed_mentions: { parse: [] }
  };
  if (replyToId) {
    body.message_reference = { message_id: replyToId };
  }

  const res = await discordRequest(`${API}/channels/${endpoint.channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = new Error(`Discord API ${res.status}`);
    err.status = res.status;
    throw err;
  }
}

async function uploadDiscordMedia(filePath, { replyToId } = {}) {
  validateMediaFile(filePath);

  const payload = {
    allowed_mentions: { parse: [] }
  };
  if (replyToId) {
    payload.message_reference = { message_id: replyToId };
  }

  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));

  const res = await discordRequest(`${API}/channels/${endpoint.channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${getResolvedBotToken()}` },
    body: form
  });

  if (!res.ok) {
    const err = new Error(`Discord API ${res.status}`);
    err.status = res.status;
    throw err;
  }
}

async function sendText(text) {
  const chunks = splitMessage(text);
  if (chunks.length === 0) return;

  for (let i = 0; i < chunks.length; i += 1) {
    const isFirst = i === 0;
    if (isFirst && endpoint.msg) {
      try {
        await sendDiscordMessage(chunks[i], { replyToId: endpoint.msg });
      } catch {
        await sendDiscordMessage(chunks[i]);
      }
    } else {
      await sendDiscordMessage(chunks[i]);
    }

    if (i < chunks.length - 1) {
      await sleep(CHUNK_DELAY_MS);
    }
  }
}

async function sendMedia(filePath) {
  if (endpoint.msg) {
    try {
      await uploadDiscordMedia(filePath, { replyToId: endpoint.msg });
      return;
    } catch (err) {
      if (!err.status) throw err;
      await uploadDiscordMedia(filePath);
      return;
    }
  }

  await uploadDiscordMedia(filePath);
}

async function clearReaction() {
  if (!endpoint.msg) return;
  const botToken = getResolvedBotToken();
  const emoji = encodeURIComponent(THINKING_REACTION);
  try {
    await discordRequest(`${API}/channels/${endpoint.channelId}/messages/${endpoint.msg}/reactions/${emoji}/@me`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${botToken}` }
    }, { maxRetries: 1 });
  } catch {}
}

export async function clearThinkingReactions({
  channelId = endpoint.channelId,
  port = null,
  botToken = null,
  fetchImpl = fetch
} = {}) {
  if (!channelId) return false;

  const resolvedToken = botToken || getResolvedBotToken();
  const resolvedPort = port || getConfig().internalPort || 3475;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${resolvedPort}/internal/clear-thinking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': getInternalToken(resolvedToken)
      },
      body: JSON.stringify({ channelId }),
      signal: controller.signal
    });
    return !!res?.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function recordOutgoing(text) {
  const botToken = getResolvedBotToken();
  const config = getConfig();
  const port = config.internalPort || 3475;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`http://127.0.0.1:${port}/internal/record-outgoing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': getInternalToken(botToken)
      },
      body: JSON.stringify({ channelId: endpoint.channelId, text }),
      signal: controller.signal
    });
  } catch {
    // Recording is best-effort; delivery already succeeded.
  } finally {
    clearTimeout(timer);
  }
}

async function cleanup() {
  if (correlationId) markTypingDone(correlationId);
  await clearThinkingReactions();
  await clearReaction();
}

async function main() {
  if (!getResolvedBotToken()) {
    console.error('Error: DISCORD_BOT_TOKEN is not set');
    process.exit(1);
  }

  if (!message) {
    console.error('Error: no message provided');
    process.exit(1);
  }

  try {
    if (message.trim() === '[SKIP]') {
      await cleanup();
      console.log('Skipped');
      return;
    }

    const media = parseMediaMessage(message);
    if (message.startsWith('[MEDIA:') && !media) {
      throw new Error('invalid media message');
    }

    if (media) {
      await sendMedia(media.filePath);
      await recordOutgoing(`[sent a file: ${path.basename(media.filePath)}]`);
      await cleanup();
      console.log('Media sent successfully');
      return;
    }

    await sendText(message);
    await recordOutgoing(message);
    await cleanup();
    console.log('Message sent successfully');
  } catch (err) {
    await cleanup();
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (IS_DIRECT) {
  main();
}
