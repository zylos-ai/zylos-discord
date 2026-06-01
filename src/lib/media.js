import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_DIR = path.join(DATA_DIR, 'media');

export function safeFileName(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return cleaned || 'file';
}

export function isImage(attachment) {
  return /^image\//i.test(attachment?.contentType || '');
}

function ensureMediaDir() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(MEDIA_DIR, 0o700);
  } catch {}
}

function assertInsideMediaDir(filePath) {
  const resolvedDir = path.resolve(MEDIA_DIR);
  const resolvedFile = path.resolve(filePath);
  return resolvedFile !== resolvedDir && resolvedFile.startsWith(resolvedDir + path.sep);
}

async function readBodyWithLimit(res, maxBytes) {
  const chunks = [];
  let total = 0;

  if (!res.body?.getReader) {
    throw new Error('response body is not streamable');
  }

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        return { skipped: true, reason: 'too_large' };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }

  return { buffer: Buffer.concat(chunks), size: total };
}

export async function downloadAttachment(attachment, { maxBytes = DEFAULT_MAX_BYTES, timeoutMs = 30000 } = {}) {
  if (!attachment?.url) return null;

  let url;
  try {
    url = new URL(attachment.url);
  } catch {
    return { skipped: true, reason: 'invalid_url', name: attachment.name };
  }
  if (url.protocol !== 'https:') {
    return { skipped: true, reason: 'invalid_url', name: attachment.name };
  }

  if (typeof attachment.size === 'number' && attachment.size > maxBytes) {
    return { skipped: true, reason: 'too_large', name: attachment.name };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    const contentLength = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { skipped: true, reason: 'too_large', name: attachment.name };
    }

    const body = await readBodyWithLimit(res, maxBytes);
    if (body.skipped) return { ...body, name: attachment.name };

    ensureMediaDir();
    const fileName = `${Date.now()}-${safeFileName(attachment.name)}`;
    const filePath = path.join(MEDIA_DIR, fileName);
    if (!assertInsideMediaDir(filePath)) {
      return { skipped: true, reason: 'invalid_path', name: attachment.name };
    }

    fs.writeFileSync(filePath, body.buffer, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}

    return {
      filePath,
      name: attachment.name,
      contentType: attachment.contentType || '',
      size: body.size
    };
  } finally {
    clearTimeout(timeout);
  }
}
