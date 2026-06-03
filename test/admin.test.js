import { describe, expect, it } from 'vitest';
import { runAdmin } from '../src/admin.js';

function makeHarness(initialConfig, saveResult = true) {
  let config = JSON.parse(JSON.stringify(initialConfig));
  const saved = [];
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  const options = {
    stdout,
    stderr,
    loadConfig: () => config,
    saveConfig: (nextConfig) => {
      if (!saveResult) return false;
      saved.push(JSON.parse(JSON.stringify(nextConfig)));
      config = nextConfig;
      return true;
    }
  };
  return { get config() { return config; }, saved, stdout, stderr, options };
}

describe('admin CLI', () => {
  it('shows masked token fields without mutating config', () => {
    const harness = makeHarness({
      enabled: true,
      botToken: 'canonical-secret',
      bot_token: 'legacy-secret'
    });

    expect(runAdmin(['show'], harness.options)).toBe(0);
    expect(harness.stdout.text).toContain('"botToken": "...cret"');
    expect(harness.stdout.text).toContain('"bot_token": "...cret"');
    expect(harness.stdout.text).not.toContain('canonical-secret');
    expect(harness.stdout.text).not.toContain('legacy-secret');
    expect(harness.config.botToken).toBe('canonical-secret');
    expect(harness.config.bot_token).toBe('legacy-secret');
  });

  it('sets owner and policies with normalized enum input', () => {
    const harness = makeHarness({ channels: {} });

    expect(runAdmin(['set-owner', '1234567890'], harness.options)).toBe(0);
    expect(runAdmin(['set-dm-policy', 'ALLOWLIST'], harness.options)).toBe(0);
    expect(runAdmin(['set-group-policy', 'DISABLED'], harness.options)).toBe(0);

    expect(harness.config.owner).toBe('1234567890');
    expect(harness.config.dmPolicy).toBe('allowlist');
    expect(harness.config.groupPolicy).toBe('disabled');
    expect(harness.saved).toHaveLength(3);
  });

  it('manages DM allowlist with string-normalized dedupe and graceful remove', () => {
    const harness = makeHarness({ dmAllowFrom: [123456] });

    expect(runAdmin(['add-dm-allow', '123456'], harness.options)).toBe(0);
    expect(harness.saved).toHaveLength(0);
    expect(runAdmin(['add-dm-allow', '555555'], harness.options)).toBe(0);
    expect(runAdmin(['remove-dm-allow', '999999'], harness.options)).toBe(0);
    expect(runAdmin(['remove-dm-allow', '123456'], harness.options)).toBe(0);

    expect(harness.config.dmAllowFrom).toEqual(['555555']);
  });

  it('adds channels without clobbering existing configuration', () => {
    const harness = makeHarness({
      channels: {
        1234567890: {
          name: 'existing',
          mode: 'smart',
          allowFrom: ['111111'],
          historyLimit: 12
        }
      }
    });

    expect(runAdmin(['add-channel', '1234567890', 'new name', 'mention'], harness.options)).toBe(0);
    expect(harness.saved).toHaveLength(0);
    expect(harness.config.channels['1234567890']).toEqual({
      name: 'existing',
      mode: 'smart',
      allowFrom: ['111111'],
      historyLimit: 12
    });

    expect(runAdmin(['add-channel', '2222222222', 'ops channel'], harness.options)).toBe(0);
    expect(harness.config.channels['2222222222']).toEqual({
      name: 'ops channel',
      mode: 'mention',
      allowFrom: []
    });
  });

  it('manages per-channel settings and allowlists', () => {
    const harness = makeHarness({
      channels: {
        1234567890: { name: 'ops', mode: 'mention' }
      }
    });

    expect(runAdmin(['set-channel-mode', '1234567890', 'SMART'], harness.options)).toBe(0);
    expect(runAdmin(['set-channel-history-limit', '1234567890', '20'], harness.options)).toBe(0);
    expect(runAdmin(['set-channel-reaction-notify', '1234567890', 'ALL'], harness.options)).toBe(0);
    expect(runAdmin(['add-channel-allow', '1234567890', '555555'], harness.options)).toBe(0);
    expect(runAdmin(['add-channel-allow', '1234567890', '555555'], harness.options)).toBe(0);
    expect(runAdmin(['remove-channel-allow', '1234567890', '999999'], harness.options)).toBe(0);

    expect(harness.config.channels['1234567890']).toMatchObject({
      mode: 'smart',
      historyLimit: 20,
      reactionNotifyMode: 'all',
      allowFrom: ['555555']
    });
  });

  it('rejects invalid input without saving', () => {
    const harness = makeHarness({
      dmPolicy: 'owner',
      channels: {
        1234567890: { name: 'ops', mode: 'mention', allowFrom: [] }
      }
    });

    expect(runAdmin(['set-dm-policy', 'everyone'], harness.options)).toBe(1);
    expect(runAdmin(['add-channel', 'not-id', 'ops'], harness.options)).toBe(1);
    expect(runAdmin(['add-channel', '2222222222', 'bad\nname'], harness.options)).toBe(1);
    expect(runAdmin(['set-channel-history-limit', '1234567890', '10abc'], harness.options)).toBe(1);
    expect(runAdmin(['set-channel-history-limit', '1234567890', '201'], harness.options)).toBe(1);
    expect(runAdmin(['set-channel-mode', '9999999999', 'smart'], harness.options)).toBe(1);
    expect(runAdmin(['set-channel-reaction-notify', '1234567890', 'mentions'], harness.options)).toBe(1);
    expect(runAdmin(['unknown'], harness.options)).toBe(1);

    expect(harness.saved).toHaveLength(0);
    expect(harness.config.dmPolicy).toBe('owner');
  });

  it('checks saveConfig return values before reporting success', () => {
    const harness = makeHarness({ channels: {} }, false);

    expect(runAdmin(['set-owner', '1234567890'], harness.options)).toBe(1);
    expect(harness.stderr.text).toContain('failed to save config');
    expect(harness.stdout.text).not.toContain('saved');
  });

  it('lists and removes channels with defined absent behavior', () => {
    const harness = makeHarness({
      groupPolicy: 'allowlist',
      channels: {
        1234567890: {
          name: 'ops',
          mode: 'mention',
          allowFrom: ['555555'],
          historyLimit: 9,
          reactionNotifyMode: 'all'
        }
      }
    });

    expect(runAdmin(['list-channels'], harness.options)).toBe(0);
    expect(harness.stdout.text).toContain('1234567890 - ops');
    expect(harness.stdout.text).toContain('reactionNotifyMode: all');
    expect(runAdmin(['list-channel-allow', '1234567890'], harness.options)).toBe(0);
    expect(runAdmin(['remove-channel', '9999999999'], harness.options)).toBe(0);
    expect(runAdmin(['remove-channel', '1234567890'], harness.options)).toBe(0);
    expect(harness.config.channels).toEqual({});
  });

  it('prints help with zero status', () => {
    const harness = makeHarness({});

    expect(runAdmin(['help'], harness.options)).toBe(0);
    expect(harness.stdout.text).toContain('set-owner <userId>');
    expect(harness.stdout.text).toContain('set-channel-reaction-notify');
    expect(harness.stdout.text).toContain('Changes apply live');
  });
});
