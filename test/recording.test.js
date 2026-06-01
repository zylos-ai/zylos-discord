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
});
