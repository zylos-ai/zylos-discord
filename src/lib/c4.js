import { execFile } from 'node:child_process';
import path from 'node:path';

const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
const ENDPOINT_KEYS = new Set(['msg', 'req']);

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
  if (!filePath) return content;
  return `${content}\n---- file: ${escapeXml(filePath)}`;
}

export function formatDmMessage({ username, text, filePath = null }) {
  return appendFilePath(
    `[DISCORD DM] ${escapeXml(username)} said: <current-message>\n${escapeXml(text)}\n</current-message>`,
    filePath
  );
}

export function formatGroupMessage({ channelName, username, text, history = [], isThread = false, smartHint = false, filePath = null }) {
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

  parts.push(`<current-message>\n${escapeXml(text)}\n</current-message>`);
  return appendFilePath(parts.join('\n'), filePath);
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
