import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_MS = 25;
const DEFAULT_STALE_MS = 30000;
const heldLocks = new Map();

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function lockPayload() {
  return `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`;
}

function lockIsStale(lockPath, staleMs, now = Date.now()) {
  try {
    const stat = fs.statSync(lockPath);
    return now - stat.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

export function acquireFileLockSync(lockPath, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryMs = DEFAULT_RETRY_MS,
  staleMs = DEFAULT_STALE_MS
} = {}) {
  const resolved = path.resolve(lockPath);
  const held = heldLocks.get(resolved);
  if (held) {
    held.count += 1;
    return () => {
      held.count -= 1;
    };
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = fs.openSync(resolved, 'wx', 0o600);
      fs.writeFileSync(fd, lockPayload());
      heldLocks.set(resolved, { count: 1, fd });
      return () => {
        const entry = heldLocks.get(resolved);
        if (!entry) return;
        entry.count -= 1;
        if (entry.count > 0) return;
        heldLocks.delete(resolved);
        try {
          fs.closeSync(entry.fd);
        } catch {}
        try {
          fs.unlinkSync(resolved);
        } catch {}
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (lockIsStale(resolved, staleMs)) {
        try {
          fs.unlinkSync(resolved);
        } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for lock: ${resolved}`);
      }
      sleepSync(retryMs);
    }
  }
}

export function withFileLockSync(lockPath, fn, options = {}) {
  const release = acquireFileLockSync(lockPath, options);
  try {
    return fn();
  } finally {
    release();
  }
}
