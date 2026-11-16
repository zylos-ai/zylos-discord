import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default function setup() {
  const previous = process.env.TMPDIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-tests-'));
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
}
