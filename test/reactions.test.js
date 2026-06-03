import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;

async function importReactions(home) {
  vi.resetModules();
  process.env.HOME = home;
  return import('../src/lib/reactions.js');
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('reactions helpers', () => {
  it('accepts only safe correlation ids', async () => {
    const mod = await importReactions(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-react-')));

    expect(mod.safeCorrelationId('123:456')).toBe('123:456');
    expect(mod.safeCorrelationId('abc_DEF-123')).toBe('abc_DEF-123');
    expect(mod.safeCorrelationId('../escape')).toBe(null);
    expect(mod.safeCorrelationId('bad/name')).toBe(null);
  });

  it('writes typing done files under DATA_DIR with private permissions', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-react-'));
    const mod = await importReactions(home);

    expect(mod.markTypingDone('123:456')).toBe(true);
    const doneFile = path.join(home, 'zylos/components/discord/typing/123:456.done');
    expect(fs.existsSync(doneFile)).toBe(true);
    expect((fs.statSync(doneFile).mode & 0o777).toString(8)).toBe('600');
  });

  it('tracks and clears pending thinking reactions by channel', async () => {
    const mod = await importReactions(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-react-')));
    const removed = [];
    const makeMessage = (id) => ({
      id,
      channel: { id: 'chan1' },
      client: { user: { id: 'bot1' } },
      react: vi.fn(async () => {}),
      reactions: {
        cache: new Map([
          [mod.THINKING_REACTION, { users: { remove: vi.fn(async (userId) => removed.push({ id, userId })) } }]
        ])
      }
    });

    const msg1 = makeMessage('msg1');
    const msg2 = makeMessage('msg2');

    await mod.setReaction(msg1);
    await mod.setReaction(msg2);

    expect(mod.pendingThinkingCount('chan1')).toBe(2);

    const result = await mod.clearThinkingReactionsForChannel('chan1');

    expect(result).toEqual({ attempted: 2, cleared: 2 });
    expect(mod.pendingThinkingCount('chan1')).toBe(0);
    expect(removed).toEqual([
      { id: 'msg1', userId: 'bot1' },
      { id: 'msg2', userId: 'bot1' }
    ]);
  });
});
