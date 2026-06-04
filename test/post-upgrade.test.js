import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-post-upgrade-'));
}

describe('post-upgrade hook', () => {
  it('writes migrated config atomically with owner-only permissions', () => {
    const home = makeHome();
    const dataDir = path.join(home, 'zylos/components/discord');
    const configPath = path.join(dataDir, 'config.json');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ botToken: 'secret' }) + '\n');

    const result = spawnSync('node', ['hooks/post-upgrade.js'], {
      cwd: path.resolve('.'),
      env: { ...process.env, HOME: home },
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      botToken: 'secret',
      enabled: true
    });
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
