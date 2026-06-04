import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;
const originalToken = process.env.DISCORD_BOT_TOKEN;
const originalApplicationId = process.env.DISCORD_APPLICATION_ID;

async function importConfig(home) {
  vi.resetModules();
  process.env.HOME = home;
  return import('../src/lib/config.js');
}

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-discord-test-'));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = originalToken;
  if (originalApplicationId === undefined) delete process.env.DISCORD_APPLICATION_ID;
  else process.env.DISCORD_APPLICATION_ID = originalApplicationId;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('config', () => {
  it('defines the Slice 1 default schema', async () => {
    const home = makeHome();
    const { DEFAULT_CONFIG } = await importConfig(home);

    expect(DEFAULT_CONFIG).toEqual({
      enabled: true,
      botToken: null,
      applicationId: null,
      owner: null,
      dmPolicy: 'owner',
      dmAllowFrom: [],
      groupPolicy: 'allowlist',
      channels: {},
      features: { downloadMedia: true },
      media: { maxBytes: 10 * 1024 * 1024 },
      historyLimit: 5,
      textMode: 'markdown',
      reactionNotifyMode: 'own',
      voiceTranscription: 'auto',
      internalPort: 3475
    });
  });

  it('loads config with defaults and normalizes scaffold snake_case keys', async () => {
    const home = makeHome();
    const mod = await importConfig(home);
    fs.mkdirSync(mod.DATA_DIR, { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({
      bot_token: 'from-config',
      application_id: 'app-123',
      features: { downloadMedia: false }
    }));

    expect(mod.loadConfig()).toMatchObject({
      enabled: true,
      botToken: 'from-config',
      applicationId: 'app-123',
      features: { downloadMedia: false },
      historyLimit: 5,
      textMode: 'markdown',
      reactionNotifyMode: 'own',
      voiceTranscription: 'auto'
    });
  });

  it('normalizes unsupported textMode values to markdown', async () => {
    const home = makeHome();
    const mod = await importConfig(home);
    fs.mkdirSync(mod.DATA_DIR, { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({
      textMode: 'html'
    }));

    expect(mod.loadConfig()).toMatchObject({
      textMode: 'markdown'
    });
  });

  it('normalizes dmPolicy values while accepting pairing', async () => {
    const home = makeHome();
    const mod = await importConfig(home);
    fs.mkdirSync(mod.DATA_DIR, { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({
      dmPolicy: 'PAIRING'
    }));

    expect(mod.loadConfig()).toMatchObject({
      dmPolicy: 'pairing'
    });

    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({
      dmPolicy: 'everyone'
    }));
    expect(mod.loadConfig()).toMatchObject({
      dmPolicy: 'owner'
    });
  });

  it('normalizes unsupported reactionNotifyMode values to own', async () => {
    const home = makeHome();
    const mod = await importConfig(home);
    fs.mkdirSync(mod.DATA_DIR, { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({
      reactionNotifyMode: 'mentions',
      channels: {
        chan1: { reactionNotifyMode: 'mentions' }
      }
    }));

    expect(mod.loadConfig()).toMatchObject({
      reactionNotifyMode: 'own',
      channels: {
        chan1: { reactionNotifyMode: 'own' }
      }
    });
  });

  it('normalizes unsupported voiceTranscription values to auto', async () => {
    const home = makeHome();
    const mod = await importConfig(home);
    fs.mkdirSync(mod.DATA_DIR, { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({
      voiceTranscription: 'api'
    }));

    expect(mod.loadConfig()).toMatchObject({
      voiceTranscription: 'auto'
    });
  });

  it('normalizes boolean voiceTranscription compatibility values', async () => {
    const home = makeHome();
    const mod = await importConfig(home);
    fs.mkdirSync(mod.DATA_DIR, { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({
      voiceTranscription: false
    }));

    expect(mod.loadConfig()).toMatchObject({
      voiceTranscription: 'disabled'
    });
  });

  it('falls back to environment credentials', async () => {
    const home = makeHome();
    process.env.DISCORD_BOT_TOKEN = 'from-env';
    process.env.DISCORD_APPLICATION_ID = 'app-env';
    const mod = await importConfig(home);

    expect(mod.getBotToken()).toBe('from-env');
    expect(mod.getApplicationId()).toBe('app-env');
  });

  it('loads environment credentials from ~/zylos/.env', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, 'zylos'), { recursive: true });
    fs.writeFileSync(path.join(home, 'zylos/.env'), 'DISCORD_BOT_TOKEN=from-dotenv\nDISCORD_APPLICATION_ID=\"app-dotenv\"\n');
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_APPLICATION_ID;
    const mod = await importConfig(home);

    expect(mod.getBotToken()).toBe('from-dotenv');
    expect(mod.getApplicationId()).toBe('app-dotenv');
  });

  it('prefers config credentials over environment credentials', async () => {
    const home = makeHome();
    process.env.DISCORD_BOT_TOKEN = 'from-env';
    process.env.DISCORD_APPLICATION_ID = 'app-env';
    const mod = await importConfig(home);
    fs.mkdirSync(mod.DATA_DIR, { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({
      botToken: 'from-config',
      applicationId: 'app-config'
    }));

    expect(mod.getBotToken()).toBe('from-config');
    expect(mod.getApplicationId()).toBe('app-config');
  });

  it('saves config atomically and returns success', async () => {
    const home = makeHome();
    const mod = await importConfig(home);

    expect(mod.saveConfig({ enabled: false, botToken: 'saved' })).toBe(true);
    expect(JSON.parse(fs.readFileSync(mod.CONFIG_PATH, 'utf8'))).toEqual({
      enabled: false,
      botToken: 'saved'
    });
    expect(fs.existsSync(`${mod.CONFIG_PATH}.tmp`)).toBe(false);
  });

  it('updates config from a freshly loaded snapshot inside the state lock', async () => {
    const home = makeHome();
    const mod = await importConfig(home);
    mod.saveConfig({ enabled: true, owner: 'owner1' });

    const stale = mod.loadConfig();
    stale.dmPolicy = 'pairing';

    mod.saveConfig({ enabled: true, owner: 'owner2' });
    const updated = mod.updateConfig((cfg) => {
      cfg.dmPolicy = stale.dmPolicy;
      return true;
    });

    expect(updated).toMatchObject({ ok: true, saved: true });
    expect(mod.loadConfig()).toMatchObject({
      owner: 'owner2',
      dmPolicy: 'pairing'
    });
  });

  it('reloads after atomic rename and survives a temporarily missing file', async () => {
    const home = makeHome();
    const mod = await importConfig(home);
    mod.saveConfig({ enabled: true });

    const seen = [];
    const stop = mod.watchConfig((cfg) => {
      seen.push(cfg.enabled);
    });

    fs.renameSync(mod.CONFIG_PATH, `${mod.CONFIG_PATH}.bak`);
    await delay(150);
    expect(seen).toEqual([]);

    fs.renameSync(`${mod.CONFIG_PATH}.bak`, mod.CONFIG_PATH);
    mod.saveConfig({ enabled: false });

    await vi.waitFor(() => {
      expect(seen).toContain(false);
    }, { timeout: 1000 });
    stop();
  });

  it('does not throw when the watcher emits an error', async () => {
    const home = makeHome();
    const fakeWatcher = new EventEmitter();
    fakeWatcher.close = vi.fn();
    vi.spyOn(fs, 'watch').mockReturnValue(fakeWatcher);
    const mod = await importConfig(home);
    fs.mkdirSync(mod.DATA_DIR, { recursive: true });
    mod.saveConfig({ enabled: true });

    mod.watchConfig(() => {});
    expect(() => fakeWatcher.emit('error', new Error('watch failed'))).not.toThrow();
    expect(fakeWatcher.close).toHaveBeenCalled();
  });
});
