import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  applyTextMode,
  clearThinkingReactions,
  formatReceipt,
  parseLinkMessage,
  parseMediaMessage,
  splitMessage,
  validateMediaFile
} from '../scripts/send.js';

function runSend(args, { input = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(process.cwd(), 'scripts/send.js'),
      ...args
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== null) {
      child.stdin.end(input);
    }
  });
}

function makeHome({ port, textMode = 'markdown' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-send-'));
  const dataDir = path.join(home, 'zylos/components/discord');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    botToken: 'secret',
    internalPort: port,
    textMode
  }));
  return home;
}

async function withFakeServers(fn) {
  const requests = [];
  let messageSeq = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText ? JSON.parse(bodyText) : null;
      requests.push({
        method: req.method,
        url: req.url,
        token: req.headers['x-internal-token'],
        body
      });

      if (req.method === 'POST' && req.url?.startsWith('/channels/')) {
        messageSeq += 1;
        const channelId = req.url.split('/')[2];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `sent-${messageSeq}`, channel_id: channelId }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn({ port: server.address().port, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('send helpers', () => {
  it('splits messages at boundaries and skips empty chunks', () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}\n\n${'c'.repeat(50)}`;
    const chunks = splitMessage(text, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks.every((chunk) => chunk.trim().length > 0)).toBe(true);
  });

  it('returns no chunks for empty text', () => {
    expect(splitMessage('', 10)).toEqual([]);
    expect(splitMessage('   ', 10)).toEqual([]);
  });

  it('parses supported media messages only', () => {
    expect(parseMediaMessage('[MEDIA:image]/tmp/a.png')).toEqual({ kind: 'image', filePath: '/tmp/a.png' });
    expect(parseMediaMessage('[MEDIA:file]  /tmp/a.pdf  ')).toEqual({ kind: 'file', filePath: '/tmp/a.pdf' });
    expect(parseMediaMessage('[MEDIA:audio]/tmp/a.mp3')).toBeNull();
    expect(parseMediaMessage('[MEDIA:file]   ')).toBeNull();
  });

  it('parses valid link messages only', () => {
    expect(parseLinkMessage('[LINK]https://example.com/a?b=1')).toEqual({ url: 'https://example.com/a?b=1' });
    expect(parseLinkMessage('[LINK]   ')).toBeNull();
    expect(parseLinkMessage('[LINK]not a url')).toBeNull();
    expect(parseLinkMessage('https://example.com')).toBeNull();
  });

  it('formats parseable receipts', () => {
    expect(formatReceipt({ id: 123, channel_id: 456 }, 'fallback')).toBe('RECEIPT {"messageId":"123","channelId":"456"}');
    expect(formatReceipt({ id: '123' }, 'fallback')).toBe('RECEIPT {"messageId":"123","channelId":"fallback"}');
    expect(formatReceipt({}, 'fallback')).toBeNull();
  });

  it('applies markdown text mode by default and escapes plain text mode', () => {
    expect(applyTextMode('**bold** _x_', {})).toBe('**bold** _x_');
    expect(applyTextMode('**bold** _x_', { textMode: 'markdown' })).toBe('**bold** _x_');
    expect(applyTextMode('**bold** _x_', { textMode: 'plain' })).toBe('\\*\\*bold\\*\\* \\_x\\_');
  });

  it('validates outbound media paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-send-media-'));
    const filePath = path.join(dir, 'file.txt');
    fs.writeFileSync(filePath, 'ok');

    expect(validateMediaFile(filePath).isFile()).toBe(true);
    expect(() => validateMediaFile(path.join(dir, 'missing.txt'))).toThrow('file not found');
    expect(() => validateMediaFile(dir)).toThrow('media path is not a file');
    expect(() => validateMediaFile(filePath, 1)).toThrow('file exceeds 10MB');
  });

  it('clears pending channel thinking reactions through the internal server', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          token: req.headers['x-internal-token'],
          body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const ok = await clearThinkingReactions({
        channelId: 'chan1',
        port,
        botToken: 'secret'
      });

      expect(ok).toBe(true);
      expect(requests).toEqual([{
        method: 'POST',
        url: '/internal/clear-thinking',
        token: crypto.createHash('sha256').update('secret').digest('hex'),
        body: { channelId: 'chan1' }
      }]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('[SKIP] cleanup clears channel thinking reactions', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const { stdout } = await runSend([
        'chan1|req:chan1:msg1',
        '[SKIP]'
      ], {
        env: {
          HOME: home
        }
      });

      expect(stdout).toContain('Skipped');
      expect(requests).toEqual([{
        method: 'POST',
        url: '/internal/clear-thinking',
        token: crypto.createHash('sha256').update('secret').digest('hex'),
        body: { channelId: 'chan1' }
      }]);
    });
  });

  it('sends argv messages and emits a receipt', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const result = await runSend(['chan1', 'hello from argv'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('RECEIPT {"messageId":"sent-1","channelId":"chan1"}');
      expect(requests.find((req) => req.url === '/channels/chan1/messages')?.body.content).toBe('hello from argv');
    });
  });

  it('sends endpoint-only piped stdin messages', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const result = await runSend(['chan1'], {
        input: 'hello from stdin',
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('RECEIPT {"messageId":"sent-1","channelId":"chan1"}');
      expect(requests.find((req) => req.url === '/channels/chan1/messages')?.body.content).toBe('hello from stdin');
    });
  });

  it('sends link markers as bare URL content and rejects malformed links', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const ok = await runSend(['chan1', '[LINK]https://example.com/page'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });
      const bad = await runSend(['chan1', '[LINK]not a url'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(ok.code).toBe(0);
      expect(requests.find((req) => req.url === '/channels/chan1/messages')?.body.content).toBe('https://example.com/page');
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('invalid link message');
    });
  });

  it('escapes outbound content when textMode is plain', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port, textMode: 'plain' });
      const result = await runSend(['chan1', '**bold** _x_'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(requests.find((req) => req.url === '/channels/chan1/messages')?.body.content).toBe('\\*\\*bold\\*\\* \\_x\\_');
    });
  });
});
