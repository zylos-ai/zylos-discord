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
import { ChannelType, Routes } from 'discord.js';
import { getBotToken, getConfig } from '../src/lib/config.js';
import { parseEndpoint } from '../src/lib/c4.js';
import { markTypingDone, safeCorrelationId, THINKING_REACTION } from '../src/lib/reactions.js';
import { getInternalToken } from '../src/lib/recording.js';

const API = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';
const MAX_LENGTH = 2000;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_THREAD_TITLE_LENGTH = 100;
const CHUNK_DELAY_MS = 400;
const IS_DIRECT = process.argv[1] === fileURLToPath(import.meta.url);

const args = process.argv.slice(2);
const shouldReadStdin = IS_DIRECT && args.length < 2 && !process.stdin.isTTY;
if (IS_DIRECT && (!args[0] || (args.length < 2 && !shouldReadStdin))) {
  console.error('Usage: send.js <endpoint_id> [message]');
  process.exit(1);
}

const endpoint = parseEndpoint(args[0]);
const argMessage = args.slice(1).join(' ');
const message = shouldReadStdin ? await readStdin(process.stdin) : argMessage;
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
let cachedSendTarget = null;

function getResolvedBotToken() {
  if (cachedBotToken === null) {
    cachedBotToken = getBotToken();
  }
  return cachedBotToken;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function channelUrl(channelId, suffix = '') {
  return `${API}/channels/${channelId}${suffix}`;
}

export async function readStdin(stdin = process.stdin) {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
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

export function parseLinkMessage(text) {
  const match = String(text || '').match(/^\[LINK](.+)$/);
  if (!match) return null;
  const url = match[1].trim();
  if (!url) return null;
  try {
    return { url: new URL(url).href };
  } catch {
    return null;
  }
}

export function escapeDiscordMarkdown(text) {
  return String(text ?? '').replace(/([\\*_~`|>#])/g, '\\$1');
}

export function applyTextMode(text, config = getConfig()) {
  try {
    return config?.textMode === 'plain'
      ? escapeDiscordMarkdown(text)
      : String(text ?? '');
  } catch {
    return escapeDiscordMarkdown(text);
  }
}

export function deriveThreadTitle(text, fallback = 'New message') {
  const firstLine = String(text ?? '').split(/\r?\n/, 1)[0].trim().replace(/\s+/g, ' ');
  const title = firstLine || fallback;
  return title.slice(0, MAX_THREAD_TITLE_LENGTH);
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

async function fetchChannel(channelId) {
  const res = await discordRequest(channelUrl(channelId), {
    method: 'GET',
    headers: { Authorization: `Bot ${getResolvedBotToken()}` }
  });

  if (!res.ok) {
    const err = new Error(`Discord API ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return await res.json();
}

function isForumRootChannel(channel) {
  return channel?.type === ChannelType.GuildForum || channel?.type === ChannelType.GuildMedia;
}

function forumThreadReceipt(thread) {
  if (!thread?.id) return thread;
  return {
    id: thread.message?.id || thread.last_message_id || thread.id,
    channel_id: thread.id
  };
}

async function resolveSendTarget() {
  if (cachedSendTarget) return cachedSendTarget;
  if (endpoint.msg) {
    cachedSendTarget = { channelId: endpoint.channelId, forumRoot: false };
    return cachedSendTarget;
  }

  let channel = null;
  try {
    channel = await fetchChannel(endpoint.channelId);
  } catch {
    cachedSendTarget = { channelId: endpoint.channelId, forumRoot: false };
    return cachedSendTarget;
  }
  cachedSendTarget = {
    channelId: endpoint.channelId,
    forumRoot: isForumRootChannel(channel)
  };
  return cachedSendTarget;
}

async function sendDiscordMessage(content, { replyToId, channelId = endpoint.channelId } = {}) {
  const botToken = getResolvedBotToken();
  const body = {
    content,
    allowed_mentions: { parse: [] }
  };
  if (replyToId) {
    body.message_reference = { message_id: replyToId };
  }

  const res = await discordRequest(channelUrl(channelId, '/messages'), {
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

  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function createForumThread(content, { titleSource, fallbackTitle = 'New message' } = {}) {
  const body = {
    name: deriveThreadTitle(titleSource ?? content, fallbackTitle),
    message: {
      content,
      allowed_mentions: { parse: [] }
    }
  };

  const res = await discordRequest(`${API}${Routes.threads(endpoint.channelId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${getResolvedBotToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = new Error(`Discord API ${res.status}`);
    err.status = res.status;
    throw err;
  }

  try {
    const thread = await res.json();
    return forumThreadReceipt(thread);
  } catch {
    return null;
  }
}

async function createForumThreadWithMedia(filePath, { fallbackTitle = 'Shared file' } = {}) {
  validateMediaFile(filePath);

  const payload = {
    name: deriveThreadTitle('', fallbackTitle),
    message: {
      allowed_mentions: { parse: [] }
    }
  };

  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));

  const res = await discordRequest(`${API}${Routes.threads(endpoint.channelId)}`, {
    method: 'POST',
    headers: { Authorization: `Bot ${getResolvedBotToken()}` },
    body: form
  });

  if (!res.ok) {
    const err = new Error(`Discord API ${res.status}`);
    err.status = res.status;
    throw err;
  }

  try {
    const thread = await res.json();
    return forumThreadReceipt(thread);
  } catch {
    return null;
  }
}

async function uploadDiscordMedia(filePath, { replyToId, channelId = endpoint.channelId } = {}) {
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

  const res = await discordRequest(channelUrl(channelId, '/messages'), {
    method: 'POST',
    headers: { Authorization: `Bot ${getResolvedBotToken()}` },
    body: form
  });

  if (!res.ok) {
    const err = new Error(`Discord API ${res.status}`);
    err.status = res.status;
    throw err;
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function sendText(text, { applyMode = true, titleSource = text } = {}) {
  const chunks = splitMessage(applyMode ? applyTextMode(text) : text);
  if (chunks.length === 0) return;

  let receipt = null;
  let channelId = endpoint.channelId;
  const target = await resolveSendTarget();
  for (let i = 0; i < chunks.length; i += 1) {
    const isFirst = i === 0;
    if (isFirst && target.forumRoot) {
      receipt = await createForumThread(chunks[i], { titleSource });
      channelId = receipt?.channel_id || receipt?.id || channelId;
    } else if (isFirst && endpoint.msg) {
      try {
        receipt = await sendDiscordMessage(chunks[i], { replyToId: endpoint.msg, channelId });
      } catch {
        receipt = await sendDiscordMessage(chunks[i], { channelId });
      }
    } else {
      receipt = await sendDiscordMessage(chunks[i], { channelId });
    }

    if (i < chunks.length - 1) {
      await sleep(CHUNK_DELAY_MS);
    }
  }
  return receipt;
}

async function sendMedia(filePath, { fallbackTitle = 'Shared file' } = {}) {
  const target = await resolveSendTarget();
  if (target.forumRoot) {
    return await createForumThreadWithMedia(filePath, { fallbackTitle });
  }

  if (endpoint.msg) {
    try {
      return await uploadDiscordMedia(filePath, { replyToId: endpoint.msg });
    } catch (err) {
      if (!err.status) throw err;
      return await uploadDiscordMedia(filePath);
    }
  }

  return await uploadDiscordMedia(filePath);
}

export function formatReceipt(receipt, fallbackChannelId = endpoint.channelId) {
  const messageId = receipt?.id ? String(receipt.id) : null;
  const channelId = receipt?.channel_id ? String(receipt.channel_id) : String(fallbackChannelId || '');
  if (!messageId || !channelId) return null;
  return `RECEIPT ${JSON.stringify({ messageId, channelId })}`;
}

function printReceipt(receipt) {
  const line = formatReceipt(receipt);
  if (line) console.log(line);
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
      const receipt = await sendMedia(media.filePath, {
        fallbackTitle: media.kind === 'image' ? 'Shared image' : 'Shared file'
      });
      await recordOutgoing(`[sent a file: ${path.basename(media.filePath)}]`);
      await cleanup();
      printReceipt(receipt);
      console.log('Media sent successfully');
      return;
    }

    const link = parseLinkMessage(message);
    if (message.startsWith('[LINK]') && !link) {
      throw new Error('invalid link message');
    }

    const receipt = link
      ? await sendText(link.url, { applyMode: false, titleSource: link.url })
      : await sendText(message);
    await recordOutgoing(message);
    await cleanup();
    printReceipt(receipt);
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
