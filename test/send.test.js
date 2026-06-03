import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { clearThinkingReactions, parseMediaMessage, splitMessage, validateMediaFile } from '../scripts/send.js';

const execFileAsync = promisify(execFile);

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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-send-skip-'));
    const dataDir = path.join(home, 'zylos/components/discord');
    fs.mkdirSync(dataDir, { recursive: true });
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
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      enabled: true,
      botToken: 'secret',
      internalPort: port
    }));

    try {
      const { stdout } = await execFileAsync(process.execPath, [
        path.join(process.cwd(), 'scripts/send.js'),
        'chan1|req:chan1:msg1',
        '[SKIP]'
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
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
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
