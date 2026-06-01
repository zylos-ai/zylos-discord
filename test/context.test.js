import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-context-'));
}

async function importContext(home) {
  vi.resetModules();
  process.env.HOME = home;
  return import('../src/lib/context.js');
}

function writeLog(home, channelId, entries) {
  const logDir = path.join(home, 'zylos/components/discord/logs/dm');
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, `${channelId}.jsonl`);
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('context history', () => {
  it('replays channel logs oldest to newest and respects the limit', async () => {
    const home = makeHome();
    writeLog(home, 'chan1', [
      { direction: 'in', username: 'A', text: 'one', messageId: 'm1' },
      { direction: 'out', text: 'two' },
      { direction: 'in', username: 'B', text: 'three', messageId: 'm3' }
    ]);
    const context = await importContext(home);

    expect(context.ensureReplay('chan1', 2)).toBe(true);
    expect(context.getHistory('chan1', null, 5)).toEqual([
      { direction: 'out', username: 'bot', text: 'two', messageId: null },
      { direction: 'in', username: 'B', text: 'three', messageId: 'm3' }
    ]);
  });

  it('skips malformed JSONL lines and keeps replay successful', async () => {
    const home = makeHome();
    const logDir = path.join(home, 'zylos/components/discord/logs/dm');
    fs.mkdirSync(logDir, { recursive: true });
    const filePath = path.join(logDir, 'chan1.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ direction: 'in', username: 'A', text: 'ok', messageId: 'm1' }),
      '{bad json}',
      JSON.stringify({ direction: 'out', text: 'reply' })
    ].join('\n') + '\n');
    const context = await importContext(home);

    expect(context.ensureReplay('chan1', 5)).toBe(true);
    fs.writeFileSync(filePath, `${JSON.stringify({ direction: 'in', username: 'B', text: 'new', messageId: 'm2' })}\n`);
    expect(context.ensureReplay('chan1', 5)).toBe(true);
    expect(context.getHistory('chan1', null, 5)).toEqual([
      { direction: 'in', username: 'A', text: 'ok', messageId: 'm1' },
      { direction: 'out', username: 'bot', text: 'reply', messageId: null }
    ]);
  });

  it('keeps live incoming and outgoing appends in the ring after replay', async () => {
    const home = makeHome();
    writeLog(home, 'chan1', [
      { direction: 'in', username: 'A', text: 'old', messageId: 'm1' }
    ]);
    const context = await importContext(home);
    const recording = await import('../src/lib/recording.js');

    expect(context.ensureReplay('chan1', 5)).toBe(true);
    recording.recordIncoming({ channelId: 'chan1', userId: 'u2', username: 'B', text: 'current', messageId: 'm2' });
    recording.recordOutgoing({ channelId: 'chan1', text: 'reply' });

    expect(context.getHistory('chan1', 'm2', 5)).toEqual([
      { direction: 'in', username: 'A', text: 'old', messageId: 'm1' }
    ]);
    expect(context.getHistory('chan1', null, 5)).toEqual([
      { direction: 'in', username: 'A', text: 'old', messageId: 'm1' },
      { direction: 'in', username: 'B', text: 'current', messageId: 'm2' },
      { direction: 'out', username: 'bot', text: 'reply', messageId: null }
    ]);
  });

  it('resolves per-channel history limits over the global default', async () => {
    const context = await importContext(makeHome());
    expect(context.channelHistoryLimit({ historyLimit: 5, channels: { c1: { historyLimit: 9 } } }, 'c1')).toBe(9);
    expect(context.channelHistoryLimit({ historyLimit: 7, channels: {} }, 'c1')).toBe(7);
  });
});
