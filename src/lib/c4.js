import { execFile } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';

const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
const ENDPOINT_KEYS = new Set(['msg', 'req']);
const MAX_EDIT_TEXT_LENGTH = 4000;

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildEndpoint(channelId, { messageId, correlationId } = {}) {
  const endpoint = [String(channelId)];
  if (messageId) endpoint.push(`msg:${messageId}`);
  endpoint.push(`req:${correlationId || `${channelId}:${messageId || ''}`}`);
  return endpoint.join('|');
}

export function normalizeCorrelationPart(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'event';
}

export function buildEventEndpoint(channelId, { messageId, kind, nonce = crypto.randomUUID(), now = Date.now() } = {}) {
  const normalizedKind = normalizeCorrelationPart(kind);
  const normalizedNonce = normalizeCorrelationPart(nonce);
  return buildEndpoint(channelId, {
    messageId,
    correlationId: `${channelId}:${messageId || ''}:${normalizedKind}:${now}:${normalizedNonce}`
  });
}

export function parseEndpoint(endpoint) {
  const [channelId, ...parts] = String(endpoint || '').split('|');
  const result = { channelId, msg: null, req: null };

  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = part.slice(0, colonIdx);
    if (!ENDPOINT_KEYS.has(key)) continue;
    result[key] = part.slice(colonIdx + 1);
  }

  return result;
}

function appendFilePath(content, filePath) {
  const filePaths = Array.isArray(filePath) ? filePath : (filePath ? [filePath] : []);
  if (filePaths.length === 0) return content;
  const trailers = filePaths.map((onePath) => `---- file: ${escapeXml(onePath)}`);
  return `${content}\n${trailers.join('\n')}`;
}

export function truncateText(text, maxLen = 100) {
  const input = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (input.length <= maxLen) return input;
  return `${input.slice(0, Math.max(0, maxLen - 3))}...`;
}

export function formatReplyingTo(replyingTo) {
  if (!replyingTo?.messageId) return null;
  const attrs = [
    `message-id="${escapeXml(replyingTo.messageId)}"`
  ];
  if (replyingTo.fromUserId) {
    attrs.push(`from-user-id="${escapeXml(replyingTo.fromUserId)}"`);
  }
  return `<replying-to ${attrs.join(' ')}>${escapeXml(truncateText(replyingTo.text))}</replying-to>`;
}

export function formatDmMessage({ username, text, filePath = null, replyingTo = null }) {
  const parts = [`[DISCORD DM] ${escapeXml(username)} said:`];
  const replyContext = formatReplyingTo(replyingTo);
  if (replyContext) parts.push(replyContext);
  parts.push(`<current-message>\n${escapeXml(text)}\n</current-message>`);
  return appendFilePath(
    parts.join('\n'),
    filePath
  );
}

export function formatGroupMessage({ channelName, username, text, history = [], isThread = false, smartHint = false, filePath = null, replyingTo = null }) {
  const label = isThread ? 'THREAD' : 'GROUP';
  const contextTag = isThread ? 'thread-context' : 'group-context';
  const parts = [`[DISCORD ${label}:${escapeXml(channelName)}] ${escapeXml(username)} said:`];

  if (history.length > 0) {
    const lines = history.map((entry) => {
      const name = entry.username || (entry.direction === 'out' ? 'bot' : 'user');
      return `[${escapeXml(name)}]: ${escapeXml(entry.text)}`;
    });
    parts.push(`<${contextTag}>\n${lines.join('\n')}\n</${contextTag}>`);
  }

  if (smartHint) {
    parts.push('<smart-mode>\nDecide whether to respond. Reply with exactly [SKIP] to stay silent if this message is not for you or does not need you.\n</smart-mode>');
  }

  const replyContext = formatReplyingTo(replyingTo);
  if (replyContext) parts.push(replyContext);

  parts.push(`<current-message>\n${escapeXml(text)}\n</current-message>`);
  return appendFilePath(parts.join('\n'), filePath);
}

export function formatReactionEvent({ username, action, emoji, targetText }) {
  return `[DISCORD REACTION] ${escapeXml(username)} ${escapeXml(action)} ${escapeXml(emoji)} to "${escapeXml(truncateText(targetText, 80))}"`;
}

export function formatMessageEditEvent({ username, newText = '' }) {
  return `[DISCORD EDIT] ${escapeXml(username)} edited their message - current text: "${escapeXml(truncateText(newText, MAX_EDIT_TEXT_LENGTH))}"`;
}

export function formatMessageDeleteEvent({ username, text = '' }) {
  const suffix = text ? `: "${escapeXml(truncateText(text, 120))}"` : '';
  return `[DISCORD DELETE] ${escapeXml(username)} deleted a message${suffix}`;
}

function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

function runC4Receive(channel, endpoint, content, callback) {
  execFile('node', [
    C4_RECEIVE,
    '--channel', channel,
    '--endpoint', endpoint,
    '--json',
    '--content', content
  ], { encoding: 'utf8', timeout: 30000 }, callback);
}

export function sendToC4(channel, endpoint, content, onReject) {
  if (!content) {
    onReject?.('Internal error, please try again.');
    return;
  }

  runC4Receive(channel, endpoint, content, (error, stdout) => {
    if (!error) return;

    const response = parseC4Response(stdout);
    if (response?.ok === false && response.error?.message) {
      onReject?.(response.error.message);
      return;
    }

    setTimeout(() => {
      runC4Receive(channel, endpoint, content, (retryError, retryStdout) => {
        if (!retryError) return;

        const retryResponse = parseC4Response(retryStdout);
        if (retryResponse?.ok === false && retryResponse.error?.message) {
          onReject?.(retryResponse.error.message);
        } else {
          onReject?.('Internal error, please try again.');
        }
      });
    }, 2000);
  });
}
