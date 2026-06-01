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
});
