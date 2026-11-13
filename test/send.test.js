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
  deriveThreadTitle,
  formatReceipt,
  parseLinkMessage,
  parseMediaMessage,
  parsePollMessage,
  splitMessage,
  validateMediaFile
} from '../scripts/send.js';
import { THINKING_REACTION } from '../src/lib/reactions.js';

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

function makeHome({ port, textMode = 'markdown', policy = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-send-'));
  const dataDir = path.join(home, 'zylos/components/discord');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    botToken: 'secret',
    internalPort: port,
    textMode,
    // Most tests exercise delivery, not policy: let any guild channel through.
    groupPolicy: 'open',
    ...policy
  }));
  return home;
}

function parseRequestBody(req, bodyText) {
  const contentType = req.headers['content-type'] || '';
  if (!bodyText) return null;
  if (contentType.includes('multipart/form-data')) {
    const payloadMatch = bodyText.match(/name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/);
    return {
      payload_json: payloadMatch ? JSON.parse(payloadMatch[1]) : null,
      multipart: true
    };
  }
  return JSON.parse(bodyText);
}

async function withFakeServers(fn, { channelTypes = {}, channelRecipients = {}, channelParents = {}, messageAuthors = {}, failChannelGets = [] } = {}) {
  const requests = [];
  const failingGets = new Set(failChannelGets);
  let messageSeq = 0;
  let threadSeq = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = parseRequestBody(req, bodyText);
      requests.push({
        method: req.method,
        url: req.url,
        token: req.headers['x-internal-token'],
        body
      });

      if (req.method === 'GET' && /^\/channels\/[^/]+\/messages\/[^/]+$/.test(req.url || '')) {
        const messageId = req.url.split('/')[4];
        const author = messageAuthors[messageId];
        res.writeHead(author ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(author ? { id: messageId, author: { id: author } } : { message: 'Unknown Message' }));
        return;
      }

      if (req.method === 'GET' && req.url?.startsWith('/channels/')) {
        const channelId = req.url.split('/')[2];
        if (failingGets.has(channelId)) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'temporary failure' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const channel = { id: channelId, type: channelTypes[channelId] ?? 0 };
        if (channelParents[channelId]) channel.parent_id = channelParents[channelId];
        if (channelRecipients[channelId]) channel.recipients = [{ id: channelRecipients[channelId] }];
        res.end(JSON.stringify(channel));
        return;
      }

      if (req.method === 'POST' && req.url?.endsWith('/threads')) {
        threadSeq += 1;
        const channelId = req.url.split('/')[2];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `thread-${threadSeq}`,
          parent_id: channelId,
          type: 11,
          message: { id: `thread-msg-${threadSeq}` }
        }));
        return;
      }

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
    expect(parseMediaMessage('[MEDIA:sticker]123456789012345678')).toEqual({ kind: 'sticker', stickerId: '123456789012345678' });
    expect(parseMediaMessage('[MEDIA:audio]/tmp/a.mp3')).toBeNull();
    expect(parseMediaMessage('[MEDIA:file]   ')).toBeNull();
    expect(parseMediaMessage('[MEDIA:sticker]not-a-snowflake')).toBeNull();
  });

  it('parses valid link messages only', () => {
    expect(parseLinkMessage('[LINK]https://example.com/a?b=1')).toEqual({ url: 'https://example.com/a?b=1' });
    expect(parseLinkMessage('[LINK]   ')).toBeNull();
    expect(parseLinkMessage('[LINK]not a url')).toBeNull();
    expect(parseLinkMessage('https://example.com')).toBeNull();
  });

  it('parses valid poll messages only', () => {
    expect(parsePollMessage(`[POLL]
Lunch?
- Pizza
- Sushi
duration: 12
multiselect: yes`)).toEqual({
      question: 'Lunch?',
      answers: ['Pizza', 'Sushi'],
      duration: 12,
      allowMultiselect: true,
      poll: {
        question: { text: 'Lunch?' },
        answers: [
          { poll_media: { text: 'Pizza' } },
          { poll_media: { text: 'Sushi' } }
        ],
        duration: 12,
        allow_multiselect: true
      }
    });
    expect(parsePollMessage('[POLL]\nQuestion?\n- One')).toBeNull();
    expect(parsePollMessage('[POLL]\nQuestion?\n- One\n- Two\nduration: 0')).toBeNull();
    expect(parsePollMessage('[POLL]\nQuestion?\n- One\n- Two\nmultiselect: maybe')).toBeNull();
    expect(parsePollMessage('Question?\n- One\n- Two')).toBeNull();
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

  it('derives forum thread titles from the first line with fallback and capping', () => {
    expect(deriveThreadTitle('  Title line  \nbody')).toBe('Title line');
    expect(deriveThreadTitle('', 'Shared file')).toBe('Shared file');
    expect(deriveThreadTitle('a'.repeat(150))).toHaveLength(100);
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
        messageId: 'msg1',
        port,
        botToken: 'secret'
      });

      expect(ok).toBe(true);
      expect(requests).toEqual([{
        method: 'POST',
        url: '/internal/clear-thinking',
        token: crypto.createHash('sha256').update('secret').digest('hex'),
        body: { channelId: 'chan1', messageId: 'msg1' }
      }]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('[SKIP] cleanup clears channel thinking reactions', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const { stdout } = await runSend([
        'chan1|msg:msg1|req:chan1:msg1',
        '[SKIP]'
      ], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(stdout).toContain('Skipped');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/internal/clear-thinking',
          token: crypto.createHash('sha256').update('secret').digest('hex'),
          body: { channelId: 'chan1', messageId: 'msg1' }
        },
        {
          method: 'DELETE',
          url: `/channels/chan1/messages/msg1/reactions/${encodeURIComponent(THINKING_REACTION)}/@me`,
          token: undefined,
          body: null
        }
      ]);
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
      expect(requests.some((req) => req.url === '/channels/chan1/threads')).toBe(false);
    });
  });

  it('creates a forum thread for fresh forum channel sends', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const result = await runSend(['forum1', 'Thread title\nbody text'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('RECEIPT {"messageId":"thread-msg-1","channelId":"thread-1"}');
      expect(requests.find((req) => req.method === 'GET' && req.url === '/channels/forum1')).toBeTruthy();
      expect(requests.find((req) => req.url === '/channels/forum1/threads')?.body).toEqual({
        name: 'Thread title',
        message: {
          content: 'Thread title\nbody text',
          allowed_mentions: { parse: [] }
        }
      });
      expect(requests.some((req) => req.url === '/channels/forum1/messages')).toBe(false);
    }, { channelTypes: { forum1: 15 } });
  });

  it('falls back to normal messages when channel type lookup fails', async () => {
    await withFakeServers(async ({ port, requests }) => {
      // A failed lookup is only tolerated for a channel listed in config.
      const home = makeHome({ port, policy: { groupPolicy: 'allowlist', channels: { chan1: { name: 'c', mode: 'mention' } } } });
      const result = await runSend(['chan1', 'fallback send'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(requests.find((req) => req.method === 'GET' && req.url === '/channels/chan1')).toBeTruthy();
      expect(requests.find((req) => req.url === '/channels/chan1/messages')?.body.content).toBe('fallback send');
      expect(requests.some((req) => req.url === '/channels/chan1/threads')).toBe(false);
    }, { failChannelGets: ['chan1'] });
  });

  it('caps forum thread titles at the Discord limit', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const title = 'a'.repeat(150);
      const result = await runSend(['forum1', `${title}\nbody`], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(requests.find((req) => req.url === '/channels/forum1/threads')?.body.name).toBe('a'.repeat(100));
    }, { channelTypes: { forum1: 15 } });
  });

  it('creates a media-channel thread with a fallback title for media-only sends', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-send-upload-'));
      const filePath = path.join(dir, 'report.txt');
      fs.writeFileSync(filePath, 'report');
      const result = await runSend(['media1', `[MEDIA:file]${filePath}`], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      const threadReq = requests.find((req) => req.url === '/channels/media1/threads');
      expect(threadReq?.body.payload_json).toEqual({
        name: 'Shared file',
        message: {
          allowed_mentions: { parse: [] }
        }
      });
      expect(threadReq?.body.multipart).toBe(true);
      expect(requests.some((req) => req.url === '/channels/media1/messages')).toBe(false);
    }, { channelTypes: { media1: 16 } });
  });

  it('sends stickers as sticker_ids with receipts', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const result = await runSend(['chan1', '[MEDIA:sticker]123456789012345678'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('RECEIPT {"messageId":"sent-1","channelId":"chan1"}');
      expect(requests.find((req) => req.url === '/channels/chan1/messages')?.body).toEqual({
        sticker_ids: ['123456789012345678'],
        allowed_mentions: { parse: [] }
      });
    });
  });

  it('creates forum threads for stickers with fallback titles', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const result = await runSend(['forum1', '[MEDIA:sticker]123456789012345678'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(requests.find((req) => req.url === '/channels/forum1/threads')?.body).toEqual({
        name: 'Sticker',
        message: {
          sticker_ids: ['123456789012345678'],
          allowed_mentions: { parse: [] }
        }
      });
    }, { channelTypes: { forum1: 15 } });
  });

  it('posts replies into existing thread channels without creating a forum thread', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const result = await runSend(['thread1|msg:parent-msg|req:thread1:parent-msg', 'reply body'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      // One channel lookup for the outbound DM check, none for forum detection.
      expect(requests.filter((req) => req.method === 'GET' && req.url === '/channels/thread1')).toHaveLength(1);
      expect(requests.some((req) => req.url === '/channels/thread1/threads')).toBe(false);
      expect(requests.find((req) => req.url === '/channels/thread1/messages')?.body).toEqual({
        content: 'reply body',
        allowed_mentions: { parse: [] },
        message_reference: { message_id: 'parent-msg' }
      });
    });
  });

  it('sends native polls and rejects malformed poll blocks', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const result = await runSend(['chan1', `[POLL]
Lunch?
- Pizza
- Sushi
duration: 2
multiselect: false`], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });
      const bad = await runSend(['chan1', '[POLL]\nLunch?\n- Pizza'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(requests.find((req) => req.url === '/channels/chan1/messages')?.body).toEqual({
        poll: {
          question: { text: 'Lunch?' },
          answers: [
            { poll_media: { text: 'Pizza' } },
            { poll_media: { text: 'Sushi' } }
          ],
          duration: 2,
          allow_multiselect: false
        },
        allowed_mentions: { parse: [] }
      });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('invalid poll message');
    });
  });

  it('creates forum threads for native polls', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port });
      const result = await runSend(['forum1', `[POLL]
Release now?
- Yes
- No`], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(requests.find((req) => req.url === '/channels/forum1/threads')?.body).toEqual({
        name: 'Release now?',
        message: {
          poll: {
            question: { text: 'Release now?' },
            answers: [
              { poll_media: { text: 'Yes' } },
              { poll_media: { text: 'No' } }
            ],
            duration: 24,
            allow_multiselect: false
          },
          allowed_mentions: { parse: [] }
        }
      });
    }, { channelTypes: { forum1: 15 } });
  });

  it('preserves link handling and plain text mode on forum thread sends', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port, textMode: 'plain' });
      const result = await runSend(['forum1', '[LINK]https://example.com/a_b#frag'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      const body = requests.find((req) => req.url === '/channels/forum1/threads')?.body;
      expect(body.name).toBe('https://example.com/a_b#frag');
      expect(body.message.content).toBe('https://example.com/a_b#frag');
    }, { channelTypes: { forum1: 15 } });

    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port, textMode: 'plain' });
      const result = await runSend(['forum1', '**bold** _x_'], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      const body = requests.find((req) => req.url === '/channels/forum1/threads')?.body;
      expect(body.name).toBe('**bold** _x_');
      expect(body.message.content).toBe('\\*\\*bold\\*\\* \\_x\\_');
    }, { channelTypes: { forum1: 15 } });
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

  it('does not escape link marker URLs when textMode is plain', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port, textMode: 'plain' });
      const url = 'https://example.com/a_b#frag';
      const result = await runSend(['chan1', `[LINK]${url}`], {
        env: {
          HOME: home,
          DISCORD_API_BASE: `http://127.0.0.1:${port}`
        }
      });

      expect(result.code).toBe(0);
      expect(requests.find((req) => req.url === '/channels/chan1/messages')?.body.content).toBe(url);
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

describe('outbound DM policy', () => {
  const dmCases = [
    ['owner', { owner: 'u-owner', dmPolicy: 'owner' }, 'u-owner', true],
    ['owner with miscased dmPolicy', { owner: 'u-owner', dmPolicy: 'Owner' }, 'u-owner', true],
    ['stranger under owner policy', { owner: 'u-owner', dmPolicy: 'owner' }, 'u-x', false],
    ['allowlisted user', { owner: 'u-owner', dmPolicy: 'allowlist', dmAllowFrom: ['u-a'] }, 'u-a', true],
    ['unlisted user under allowlist', { owner: 'u-owner', dmPolicy: 'allowlist', dmAllowFrom: ['u-a'] }, 'u-x', false],
    ['unapproved user under pairing', { owner: 'u-owner', dmPolicy: 'pairing', dmAllowFrom: [] }, 'u-x', false],
    ['anyone under open', { owner: 'u-owner', dmPolicy: 'open' }, 'u-x', true]
  ];

  for (const [name, policy, recipient, allowed] of dmCases) {
    it(`${allowed ? 'sends' : 'blocks'} DM to ${name}`, async () => {
      await withFakeServers(async ({ port, requests }) => {
        const home = makeHome({ port, policy });
        const result = await runSend(['dm1', 'hello'], {
          env: { HOME: home, DISCORD_API_BASE: `http://127.0.0.1:${port}` }
        });
        const posted = requests.some((req) => req.method === 'POST' && req.url === '/channels/dm1/messages');
        expect(posted).toBe(allowed);
        expect(result.code).toBe(allowed ? 0 : 2);
        if (!allowed) {
          expect(result.stderr).toContain('outbound blocked');
          expect(requests.some((req) => req.url === '/internal/record-outgoing')).toBe(false);
        }
      }, { channelTypes: { dm1: 1 }, channelRecipients: { dm1: recipient } });
    });
  }

  it('blocks media to a disallowed DM before uploading', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port, policy: { owner: 'u-owner', dmPolicy: 'owner' } });
      const file = path.join(home, 'a.txt');
      fs.writeFileSync(file, 'x');
      const result = await runSend(['dm1', `[MEDIA:file]${file}`], {
        env: { HOME: home, DISCORD_API_BASE: `http://127.0.0.1:${port}` }
      });
      expect(result.code).toBe(2);
      expect(requests.some((req) => req.method === 'POST' && req.url?.startsWith('/channels/dm1'))).toBe(false);
    }, { channelTypes: { dm1: 1 }, channelRecipients: { dm1: 'u-x' } });
  });

  it('blocks a DM-looking endpoint when the channel lookup fails', async () => {
    await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port, policy: { owner: 'u-owner', dmPolicy: 'open' } });
      const result = await runSend(['dm1|msg:m1|dm:1', 'hello'], {
        env: { HOME: home, DISCORD_API_BASE: `http://127.0.0.1:${port}` }
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('cannot verify destination');
      expect(requests.some((req) => req.method === 'POST' && req.url === '/channels/dm1/messages')).toBe(false);
    }, { failChannelGets: ['dm1'] });
  });
});

describe('outbound guild channel policy', () => {
  const allowlist = { owner: 'u-owner', groupPolicy: 'allowlist', channels: { chanA: { name: 'a', mode: 'mention' } } };

  async function sendTo(endpointStr, policy, serverOpts = {}) {
    return await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port, policy });
      const result = await runSend([endpointStr, 'hello'], {
        env: { HOME: home, DISCORD_API_BASE: `http://127.0.0.1:${port}` }
      });
      const channelId = endpointStr.split('|')[0];
      const posted = requests.some((req) => req.method === 'POST' && req.url === `/channels/${channelId}/messages`);
      return { result, posted };
    }, serverOpts);
  }

  it('sends to an allowlisted channel', async () => {
    const { result, posted } = await sendTo('chanA', allowlist);
    expect(result.code).toBe(0);
    expect(posted).toBe(true);
  });

  it('sends to a thread whose parent is allowlisted', async () => {
    const { posted } = await sendTo('thr1', allowlist, { channelTypes: { thr1: 11 }, channelParents: { thr1: 'chanA' } });
    expect(posted).toBe(true);
  });

  it('blocks a proactive send to an unlisted channel', async () => {
    const { result, posted } = await sendTo('chanX', allowlist);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('outbound blocked: channel chanX is not allowed');
    expect(posted).toBe(false);
  });

  it('allows a reply to an owner message in an unlisted channel', async () => {
    const { result, posted } = await sendTo('chanX|msg:m1', allowlist, { messageAuthors: { m1: 'u-owner' } });
    expect(result.code).toBe(0);
    expect(posted).toBe(true);
  });

  it('blocks a reply to a non-owner message in an unlisted channel', async () => {
    const { result, posted } = await sendTo('chanX|msg:m1', allowlist, { messageAuthors: { m1: 'u-other' } });
    expect(result.code).toBe(2);
    expect(posted).toBe(false);
  });

  it('blocks every guild send, owner replies included, when groupPolicy is disabled', async () => {
    const disabled = { ...allowlist, groupPolicy: 'disabled' };
    expect((await sendTo('chanA', disabled)).posted).toBe(false);
    expect((await sendTo('chanA|msg:m1', disabled, { messageAuthors: { m1: 'u-owner' } })).posted).toBe(false);
  });

  it('on lookup failure sends only to a channel listed in config', async () => {
    expect((await sendTo('chanA', allowlist, { failChannelGets: ['chanA'] })).posted).toBe(true);
    expect((await sendTo('chanX', allowlist, { failChannelGets: ['chanX'] })).posted).toBe(false);
  });
});

describe('outbound decisions use the real conversation type (review PR #25)', () => {
  const allowlist = { owner: 'u-owner', groupPolicy: 'allowlist', channels: { chanA: { name: 'a', mode: 'mention' } } };
  const botToken = `${Buffer.from('999').toString('base64')}.x.y`;

  async function sendTo(endpointStr, policy, serverOpts = {}, { kinds = null } = {}) {
    return await withFakeServers(async ({ port, requests }) => {
      const home = makeHome({ port, policy });
      const kindsPath = path.join(home, 'zylos/components/discord/channel-kinds.json');
      if (kinds) fs.writeFileSync(kindsPath, JSON.stringify(kinds));
      const result = await runSend([endpointStr, 'hello'], {
        env: { HOME: home, DISCORD_API_BASE: `http://127.0.0.1:${port}` }
      });
      const channelId = endpointStr.split('|')[0];
      const posted = requests.some((req) => req.method === 'POST' && req.url === `/channels/${channelId}/messages`);
      const stored = fs.existsSync(kindsPath) ? JSON.parse(fs.readFileSync(kindsPath, 'utf8')) : {};
      return { result, posted, stored };
    }, serverOpts);
  }

  it('a dm:1 marker on a guild channel does not make it a DM', async () => {
    const { result, posted } = await sendTo('chanX|dm:1', { ...allowlist, dmPolicy: 'open' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('channel chanX is not allowed');
    expect(posted).toBe(false);
  });

  it('records the kind learned from the channel lookup', async () => {
    const { stored } = await sendTo('dm1', { owner: 'u-owner' }, { channelTypes: { dm1: 1 }, channelRecipients: { dm1: 'u-owner' } });
    expect(stored.dm1).toEqual({ kind: 'dm', userId: 'u-owner' });
  });

  it('lookup failure: a recorded DM follows the DM policy of its recipient', async () => {
    const opts = { failChannelGets: ['dm1'] };
    const allowed = await sendTo('dm1', { owner: 'u-owner' }, opts, { kinds: { dm1: { kind: 'dm', userId: 'u-owner' } } });
    expect(allowed.posted).toBe(true);
    const denied = await sendTo('dm1', { owner: 'u-owner' }, opts, { kinds: { dm1: { kind: 'dm', userId: 'u-x' } } });
    expect(denied.result.code).toBe(2);
    expect(denied.posted).toBe(false);
  });

  it('lookup failure: a recorded thread uses its parent policy', async () => {
    const r = await sendTo('thr1', allowlist, { failChannelGets: ['thr1'] }, { kinds: { thr1: { kind: 'guild', policyChannelId: 'chanA' } } });
    expect(r.posted).toBe(true);
  });

  it('lookup failure with groupPolicy=open: a listed channel still sends, an unknown one does not', async () => {
    const open = { ...allowlist, groupPolicy: 'open' };
    expect((await sendTo('chanA', open, { failChannelGets: ['chanA'] })).posted).toBe(true);
    expect((await sendTo('chanX', open, { failChannelGets: ['chanX'] })).posted).toBe(false);
  });

  it('lookup failure with groupPolicy=disabled: even a listed channel is blocked', async () => {
    const r = await sendTo('chanA', { ...allowlist, groupPolicy: 'disabled' }, { failChannelGets: ['chanA'] });
    expect(r.result.code).toBe(2);
    expect(r.posted).toBe(false);
  });

  it('allows a reply to the bot\'s own message in an unlisted channel (owner reacted to a bot reply)', async () => {
    const r = await sendTo('chanX|msg:m1', { ...allowlist, botToken }, { messageAuthors: { m1: '999' } });
    expect(r.result.code).toBe(0);
    expect(r.posted).toBe(true);
  });

  it('still blocks when the reply target cannot be fetched', async () => {
    const r = await sendTo('chanX|msg:m404', { ...allowlist, botToken });
    expect(r.result.code).toBe(2);
    expect(r.posted).toBe(false);
  });
});
