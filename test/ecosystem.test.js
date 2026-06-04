import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('pm2 ecosystem config', () => {
  it('sets minimum uptime so fast crash loops are surfaced', () => {
    const config = require(path.join(process.cwd(), 'ecosystem.config.cjs'));
    const app = config.apps.find((entry) => entry.name === 'zylos-discord');

    expect(app).toBeTruthy();
    expect(app.max_restarts).toBe(10);
    expect(app.min_uptime).toBe('10s');
  });
});
