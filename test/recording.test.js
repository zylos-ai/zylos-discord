import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;

async function importRecording(home) {
  vi.resetModules();
  process.env.HOME = home;
  return import('../src/lib/recording.js');
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('recording helpers', () => {
  it('derives stable internal tokens', async () => {
    const mod = await importRecording(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-record-')));
    expect(mod.getInternalToken('secret')).toMatch(/^[a-f0-9]{64}$/);
    expect(mod.getInternalToken('secret')).toBe(mod.getInternalToken('secret'));
  });

  it('compares internal tokens safely', async () => {
    const mod = await importRecording(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-record-')));
    expect(mod.timingSafeStringEqual('abc', 'abc')).toBe(true);
    expect(mod.timingSafeStringEqual('abc', 'abd')).toBe(false);
    expect(mod.timingSafeStringEqual('abc', 'abcd')).toBe(false);
  });

  it('records DM logs with private directory and file permissions', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-record-'));
    const mod = await importRecording(home);

    mod.recordIncoming({
      channelId: 'channel/unsafe',
      userId: 'user1',
      username: 'Felix',
      text: 'hello',
      messageId: 'msg1'
    });
    mod.recordOutgoing({ channelId: 'channel/unsafe', text: 'hi' });

    const logDir = path.join(home, 'zylos/components/discord/logs/dm');
    const logFile = path.join(logDir, 'channel_unsafe.jsonl');
    expect((fs.statSync(logDir).mode & 0o777).toString(8)).toBe('700');
    expect((fs.statSync(logFile).mode & 0o777).toString(8)).toBe('600');

    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ direction: 'in', text: 'hello' });
    expect(lines[1]).toMatchObject({ direction: 'out', text: 'hi' });
  });

  it('routes record-outgoing by pathname and keeps token gate enforced', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-record-'));
    const mod = await importRecording(home);
    const token = 'internal-token';
    const server = mod.startRecordingServer({ port: 0, internalToken: token });
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/internal/record-outgoing?x=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': 'wrong'
        },
        body: JSON.stringify({ channelId: 'chan1', text: 'blocked' })
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`http://127.0.0.1:${port}/internal/record-outgoing?x=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token
        },
        body: JSON.stringify({ channelId: 'chan1', text: 'hello' })
      });
      expect(authorized.status).toBe(200);

      const logFile = path.join(home, 'zylos/components/discord/logs/dm/chan1.jsonl');
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ direction: 'out', text: 'hello' });
    } finally {
      mod.stopRecordingServer();
    }
  });

  it('clears all pending thinking reactions for a channel through the internal endpoint', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-record-'));
    const mod = await importRecording(home);
    const reactions = await import('../src/lib/reactions.js');
    const token = 'internal-token';
    const removed = [];
    const makeMessage = (id) => ({
      id,
      channel: { id: 'chan1' },
      client: { user: { id: 'bot1' } },
      react: vi.fn(async () => {}),
      reactions: {
        cache: new Map([
          [reactions.THINKING_REACTION, { users: { remove: vi.fn(async (userId) => removed.push({ id, userId })) } }]
        ])
      }
    });

    await reactions.setReaction(makeMessage('msg1'));
    await reactions.setReaction(makeMessage('msg2'));
    expect(reactions.pendingThinkingCount('chan1')).toBe(2);

    const server = mod.startRecordingServer({ port: 0, internalToken: token });
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/clear-thinking?x=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token
        },
        body: JSON.stringify({ channelId: 'chan1' })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ ok: true, attempted: 2, cleared: 2 });
      expect(reactions.pendingThinkingCount('chan1')).toBe(0);
      expect(removed).toEqual([
        { id: 'msg1', userId: 'bot1' },
        { id: 'msg2', userId: 'bot1' }
      ]);
    } finally {
      mod.stopRecordingServer();
    }
  });

  it('clears one pending thinking reaction by message through the internal endpoint', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-record-'));
    const mod = await importRecording(home);
    const reactions = await import('../src/lib/reactions.js');
    const token = 'internal-token';
    const removed = [];
    const makeMessage = (id) => ({
      id,
      channel: { id: 'chan1' },
      client: { user: { id: 'bot1' } },
      react: vi.fn(async () => {}),
      reactions: {
        cache: new Map([
          [reactions.THINKING_REACTION, { users: { remove: vi.fn(async (userId) => removed.push({ id, userId })) } }]
        ])
      }
    });

    await reactions.setReaction(makeMessage('msg1'));
    await reactions.setReaction(makeMessage('msg2'));

    const server = mod.startRecordingServer({ port: 0, internalToken: token });
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/clear-thinking?x=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token
        },
        body: JSON.stringify({ channelId: 'chan1', messageId: 'msg1' })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ ok: true, attempted: 1, cleared: 1 });
      expect(reactions.pendingThinkingCount('chan1')).toBe(1);
      expect(removed).toEqual([{ id: 'msg1', userId: 'bot1' }]);
    } finally {
      mod.stopRecordingServer();
    }
  });
});
