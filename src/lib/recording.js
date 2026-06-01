import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DATA_DIR, getBotToken } from './config.js';
import { appendToRing } from './context.js';

const LOG_DIR = path.join(DATA_DIR, 'logs', 'dm');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

let server = null;
let retries = 0;

export function getInternalToken(token = getBotToken()) {
  return crypto.createHash('sha256').update(token || '').digest('hex');
}

export function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function safeLogName(channelId) {
  return String(channelId || '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(LOG_DIR, 0o700);
  } catch {}
}

export function appendDmLog(channelId, entry) {
  ensureLogDir();
  const filePath = path.join(LOG_DIR, `${safeLogName(channelId)}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

export function recordIncoming({ channelId, userId, username, text, messageId }) {
  const entry = {
    direction: 'in',
    userId: String(userId),
    username,
    text,
    messageId: String(messageId)
  };
  appendDmLog(channelId, entry);
  appendToRing(channelId, entry);
}

export function recordOutgoing({ channelId, text }) {
  const entry = {
    direction: 'out',
    text
  };
  appendDmLog(channelId, entry);
  appendToRing(channelId, entry);
}

function readJsonBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request too large' }));
        }
        req.destroy();
        reject(new Error('Request too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleRecordOutgoing(req, res, internalToken) {
  const suppliedToken = req.headers['x-internal-token'];
  if (!timingSafeStringEqual(suppliedToken, internalToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    const body = await readJsonBody(req, res);
    if (res.headersSent) return;
    if (!body.channelId || typeof body.text !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'channelId and text are required' }));
      return;
    }

    recordOutgoing({ channelId: body.channelId, text: body.text });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}

export function startRecordingServer({ port, internalToken = getInternalToken() }) {
  if (server) return server;

  const listen = () => {
    server.listen(port, '127.0.0.1', () => {
      retries = 0;
      console.log(`[discord] internal recording server listening on 127.0.0.1:${port}`);
    });
  };

  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/internal/record-outgoing') {
      handleRecordOutgoing(req, res, internalToken);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries < MAX_RETRIES) {
      retries += 1;
      console.error(`[discord] internal port ${port} in use, retrying in ${RETRY_DELAY_MS}ms (${retries}/${MAX_RETRIES})`);
      setTimeout(listen, RETRY_DELAY_MS);
      return;
    }
    console.error(`[discord] internal recording server error: ${err.message}`);
  });

  listen();
  return server;
}

export function stopRecordingServer() {
  if (!server) return;
  try {
    server.close();
  } catch {}
  server = null;
  retries = 0;
}
