import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireFileLockSync } from '../src/lib/file-lock.js';

function tempLockPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-lock-')), '.state.lock');
}

describe('file lock helper', () => {
  it('does not break a stale-looking lock owned by a live process', () => {
    const lockPath = tempLockPath();
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60000 })}\n`);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, old, old);

    expect(() => acquireFileLockSync(lockPath, {
      timeoutMs: 30,
      retryMs: 5,
      staleMs: 1
    })).toThrow(/timed out waiting for lock/);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
