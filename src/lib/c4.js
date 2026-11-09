import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sessionGroupFromEndpoint } from './session-group.js';

export function getC4ReceivePath() {
  return path.join(process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos'),
    '.claude/skills/comm-bridge/scripts/c4-receive.js');
}

/**
 * Whether the installed Core's c4-receive accepts an option. Read from
 * c4-receive-options.json next to c4-receive.js on every call; a missing or
 * unreadable manifest means "not supported" (older Core), never a version check.
 */
export function c4ReceiveSupportsOption(name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(getC4ReceivePath()), 'c4-receive-options.json'), 'utf8'));
    return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.options !== null && typeof manifest.options === 'object'
      && !Array.isArray(manifest.options) && Object.hasOwn(manifest.options, name);
  } catch {
    return false;
  }
}

export function buildC4ReceiveArgs({ channel, endpoint, content, sessionGroup }) {
  const args = ['--channel', channel, '--endpoint', endpoint, '--json', '--content', content];
  if (sessionGroup != null && sessionGroup !== '' && c4ReceiveSupportsOption('--session-group')) {
    args.push('--session-group', sessionGroup);
  }
  return args;
}

export const GENERIC_REJECT_REPLY = "Sorry, I couldn't take this message right now. Please try again later.";
export const UNCERTAIN_REPLY = "Sorry, this message may not have reached me. If you don't get a reply in a few minutes, please send it again.";

/**
 * Classify a structured c4-receive rejection by error.persisted:
 * non-empty array = Core committed the inbound row (send nothing, do not resend);
 * empty array = nothing stored; anything else = Core cannot tell.
 * @returns {'committed'|'not_stored'|'uncertain'}
 */
export function classifyC4Rejection(response) {
  const persisted = response?.error?.persisted;
  if (!Array.isArray(persisted)) return 'uncertain';
  return persisted.length > 0 ? 'committed' : 'not_stored';
}
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
  const filePaths = (Array.isArray(filePath) ? filePath : (filePath ? [filePath] : [])).filter(Boolean);
  if (filePaths.length === 0) return content;
  const trailers = filePaths.map((onePath) => `---- file: ${escapeXml(onePath)}`);
  return `${content}\n${trailers.join('\n')}`;
}

function capTextPreservingWhitespace(text, maxLen) {
  const input = String(text ?? '');
  if (input.length <= maxLen) return input;
  return `${input.slice(0, Math.max(0, maxLen - 3))}...`;
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
  return `[DISCORD EDIT] ${escapeXml(username)} edited their message - current text: "${escapeXml(capTextPreservingWhitespace(newText, MAX_EDIT_TEXT_LENGTH))}"`;
}

export function formatMessageDeleteEvent({ username, text = '' }) {
  const suffix = text ? `: "${escapeXml(truncateText(text, 120))}"` : '';
  return `[DISCORD DELETE] ${escapeXml(username)} deleted a message${suffix}`;
}

export function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Send an inbound message to the agent via C4.
 * The session group is derived from the endpoint and passed only when the
 * installed Core lists --session-group (rechecked on every call, including the
 * retry). A rejected group is never dropped and resent to the overall group,
 * and Core's error text (written for the agent) only goes to the log.
 * No component-side timeout kills c4-receive: killing it after Core stored the
 * row and retrying would deliver the message twice.
 * @param {string} channel - Channel name
 * @param {string} endpoint - Endpoint ID
 * @param {string} content - Message content
 * @param {function} [onReject] - Called once when the agent will not answer this
 *   message: with a user-facing notice to send, or with null when Core already
 *   committed the inbound row (clean up typing/reaction only, send nothing)
 * @param {object} [opts]
 * @param {number} [opts.retryDelayMs=2000]
 * @param {function} [opts.onDone] - Test hook: called with the final outcome
 * @param {function} [opts.exec] - Test hook replacing child_process.execFile
 */
export function sendToC4(channel, endpoint, content, onReject, { retryDelayMs = 2000, onDone, exec = execFile } = {}) {
  const done = (outcome) => { if (onDone) onDone(outcome); };
  if (!content) {
    console.error('[discord] sendToC4 called with empty content');
    onReject?.(GENERIC_REJECT_REPLY);
    return done('rejected');
  }
  let sessionGroup;
  try {
    sessionGroup = sessionGroupFromEndpoint(endpoint);
  } catch (err) {
    // Never fall back to the overall group.
    console.error(`[discord] cannot derive session group, not sending: ${err.message}`);
    onReject?.(GENERIC_REJECT_REPLY);
    return done('rejected');
  }

  const run = (cb) => exec(process.execPath,
    [getC4ReceivePath(), ...buildC4ReceiveArgs({ channel, endpoint, content, sessionGroup })],
    { encoding: 'utf8' }, cb);

  const handleRejection = (response, label) => {
    const { code, message } = response.error;
    const kind = classifyC4Rejection(response);
    if (kind === 'committed') {
      console.warn(`[discord] C4 ${label} after commit (${code}), not resending: ${message}`);
      onReject?.(null);
      return done('committed');
    }
    console.warn(`[discord] C4 ${label} (${code}, ${kind}) [group=${sessionGroup}]: ${message}`);
    onReject?.(kind === 'not_stored' ? GENERIC_REJECT_REPLY : UNCERTAIN_REPLY);
    return done('rejected');
  };

  run((error, stdout) => {
    if (!error) return done('sent');
    const response = parseC4Response(stdout);
    if (response?.ok === false && response.error?.message) return handleRejection(response, 'rejected');
    // Unexpected failure (node crash, etc.) - retry once
    console.warn(`[discord] C4 send failed, retrying in ${retryDelayMs}ms: ${error.message}`);
    setTimeout(() => {
      run((retryError, retryStdout) => {
        if (!retryError) return done('sent');
        const retryResponse = parseC4Response(retryStdout);
        if (retryResponse?.ok === false && retryResponse.error?.message) {
          return handleRejection(retryResponse, 'rejected after retry');
        }
        console.error(`[discord] C4 send failed after retry: ${retryError.message}`);
        onReject?.(UNCERTAIN_REPLY);
        return done('failed');
      });
    }, retryDelayMs);
  });
}
