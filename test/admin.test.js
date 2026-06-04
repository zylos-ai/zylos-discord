import { describe, expect, it } from 'vitest';
import { runAdmin } from '../scripts/admin.js';
import { isSenderAllowed, resolveGuildAccess } from '../src/lib/auth.js';

function makeHarness(initialConfig, saveResult = true) {
  let config = JSON.parse(JSON.stringify(initialConfig));
  let pairingState = { pending: {}, denied: {} };
  let saveConfigResult = saveResult;
  let savePairingResult = saveResult;
  const saved = [];
  const savedPairing = [];
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  const options = {
    stdout,
    stderr,
    loadConfig: () => config,
    saveConfig: (nextConfig) => {
      if (!saveConfigResult) return false;
      saved.push(JSON.parse(JSON.stringify(nextConfig)));
      config = nextConfig;
      return true;
    },
    loadPairingState: () => pairingState,
    savePairingState: (nextState) => {
      if (!savePairingResult) return false;
      savedPairing.push(JSON.parse(JSON.stringify(nextState)));
      pairingState = nextState;
      return true;
    },
    withStateLock: (fn) => fn()
  };
  return {
    get config() { return config; },
    get pairingState() { return pairingState; },
    set pairingState(nextState) { pairingState = nextState; },
    set saveConfigResult(value) { saveConfigResult = value; },
    set savePairingResult(value) { savePairingResult = value; },
    saved,
    savedPairing,
    stdout,
    stderr,
    options
  };
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
    expect(runAdmin(['set-dm-policy', 'PAIRING'], harness.options)).toBe(0);
    expect(runAdmin(['set-group-policy', 'OPEN'], harness.options)).toBe(0);
    expect(runAdmin(['set-group-policy', 'DISABLED'], harness.options)).toBe(0);

    expect(harness.config.owner).toBe('1234567890');
    expect(harness.config.dmPolicy).toBe('pairing');
    expect(harness.config.groupPolicy).toBe('disabled');
    expect(harness.saved).toHaveLength(4);
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

  it('lists pending DM pairing requests with an empty state message', () => {
    const harness = makeHarness({});

    expect(runAdmin(['dm-pending'], harness.options)).toBe(0);
    expect(harness.stdout.text).toContain('No pending DM pairing requests');

    harness.stdout.text = '';
    harness.pairingState = {
      pending: {
        1234567890: {
          userId: '1234567890',
          name: 'Felix',
          requestedAt: '2026-06-04T00:00:00.000Z',
          firstMessage: 'hello'
        }
      },
      denied: {}
    };

    expect(runAdmin(['dm-pending'], harness.options)).toBe(0);
    expect(harness.stdout.text).toContain('1234567890 - Felix');
    expect(harness.stdout.text).toContain('requestedAt: 2026-06-04T00:00:00.000Z');
    expect(harness.stdout.text).toContain('firstMessage: hello');
  });

  it('approves and denies DM pairing requests through owner-only state mutation', () => {
    const harness = makeHarness({
      dmPolicy: 'pairing',
      dmAllowFrom: ['1111111111']
    });
    harness.pairingState = {
      pending: {
        1234567890: { userId: '1234567890', name: 'Felix' },
        2222222222: { userId: '2222222222', name: 'Blocked' }
      },
      denied: {
        1234567890: { userId: '1234567890', reason: 'old' }
      }
    };

    expect(runAdmin(['dm-approve', '1234567890'], harness.options)).toBe(0);
    expect(harness.config.dmAllowFrom).toEqual(['1111111111', '1234567890']);
    expect(harness.pairingState.pending['1234567890']).toBeUndefined();
    expect(harness.pairingState.denied['1234567890']).toBeUndefined();

    expect(runAdmin(['dm-deny', '2222222222', 'spam', 'risk'], harness.options)).toBe(0);
    expect(harness.pairingState.pending['2222222222']).toBeUndefined();
    expect(harness.pairingState.denied['2222222222']).toMatchObject({
      userId: '2222222222',
      reason: 'spam risk'
    });
    expect(harness.savedPairing).toHaveLength(2);
  });

  it('rolls back config when DM pairing state save fails', () => {
    const harness = makeHarness({
      dmPolicy: 'pairing',
      dmAllowFrom: ['1111111111']
    });
    harness.pairingState = {
      pending: {
        1234567890: { userId: '1234567890', name: 'Felix' }
      },
      denied: {}
    };
    harness.savePairingResult = false;

    expect(runAdmin(['dm-approve', '1234567890'], harness.options)).toBe(1);
    expect(harness.stderr.text).toContain('failed to save pairing state');
    expect(harness.config.dmAllowFrom).toEqual(['1111111111']);
    expect(harness.pairingState.pending['1234567890']).toBeDefined();
    expect(harness.saved.at(-1)).toMatchObject({
      dmAllowFrom: ['1111111111']
    });
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

    harness.config.owner = '9999999999';
    expect(runAdmin(['add-channel', '2222222222', 'ops channel'], harness.options)).toBe(0);
    expect(harness.config.channels['2222222222']).toEqual({
      name: 'ops channel',
      mode: 'mention',
      allowFrom: ['9999999999']
    });
  });

  it('defaults added channels to owner-only and allows explicit broadening', () => {
    const harness = makeHarness({
      owner: '1111111111',
      groupPolicy: 'allowlist',
      channels: {}
    });

    expect(runAdmin(['add-channel', '2222222222', 'ops channel'], harness.options)).toBe(0);
    expect(harness.config.channels['2222222222'].allowFrom).toEqual(['1111111111']);
    expect(resolveGuildAccess(harness.config, '2222222222', '1111111111').ok).toBe(true);
    expect(resolveGuildAccess(harness.config, '2222222222', '3333333333').ok).toBe(false);

    expect(runAdmin(['add-channel-allow', '2222222222', '3333333333'], harness.options)).toBe(0);
    expect(resolveGuildAccess(harness.config, '2222222222', '3333333333').ok).toBe(true);

    expect(runAdmin(['add-channel-allow', '2222222222', '*'], harness.options)).toBe(0);
    expect(resolveGuildAccess(harness.config, '2222222222', '4444444444').ok).toBe(true);
  });

  it('falls back to allow-all when adding a channel before owner binding', () => {
    const harness = makeHarness({
      owner: null,
      channels: {}
    });

    expect(runAdmin(['add-channel', '2222222222', 'ops channel'], harness.options)).toBe(0);
    expect(harness.config.channels['2222222222'].allowFrom).toEqual([]);
    expect(harness.stderr.text).toContain('Owner not configured');
  });

  it('manages per-channel settings and allowlists', () => {
    const harness = makeHarness({
      channels: {
        1234567890: { name: 'ops', mode: 'mention' }
      }
    });

    expect(runAdmin(['set-channel-mode', '1234567890', 'SMART'], harness.options)).toBe(0);
    expect(runAdmin(['set-thread-mode', '1234567890', '9876543210', 'MENTION'], harness.options)).toBe(0);
    expect(runAdmin(['set-channel-history-limit', '1234567890', '20'], harness.options)).toBe(0);
    expect(runAdmin(['set-channel-reaction-notify', '1234567890', 'ALL'], harness.options)).toBe(0);
    expect(runAdmin(['add-channel-allow', '1234567890', '555555'], harness.options)).toBe(0);
    expect(runAdmin(['add-channel-allow', '1234567890', '555555'], harness.options)).toBe(0);
    expect(runAdmin(['remove-channel-allow', '1234567890', '999999'], harness.options)).toBe(0);

    expect(harness.config.channels['1234567890']).toMatchObject({
      mode: 'smart',
      threads: {
        9876543210: { mode: 'mention' }
      },
      historyLimit: 20,
      reactionNotifyMode: 'all',
      allowFrom: ['555555']
    });
  });

  it('replaces channel allowFrom with validated deduped entries', () => {
    const harness = makeHarness({
      owner: '1111111111',
      channels: {
        1234567890: {
          name: 'ops',
          mode: 'mention',
          allowFrom: ['9999999999']
        }
      }
    });

    expect(runAdmin([
      'set-channel-allowfrom',
      '1234567890',
      '1111111111',
      '2222222222',
      '1111111111'
    ], harness.options)).toBe(0);
    expect(harness.config.channels['1234567890'].allowFrom).toEqual([
      '1111111111',
      '2222222222'
    ]);
    expect(harness.stdout.text).toContain('allowFrom=1111111111, 2222222222');

    expect(runAdmin(['set-channel-allowfrom', '1234567890', '*'], harness.options)).toBe(0);
    expect(harness.config.channels['1234567890'].allowFrom).toEqual(['*']);

    expect(runAdmin(['set-channel-allowfrom', '1234567890', '1111111111'], harness.options)).toBe(0);
    expect(harness.config.channels['1234567890'].allowFrom).toEqual(['1111111111']);
  });

  it('rejects empty, invalid, and unconfigured set-channel-allowfrom calls', () => {
    const harness = makeHarness({
      channels: {
        1234567890: { name: 'ops', mode: 'mention', allowFrom: ['1111111111'] }
      }
    });

    expect(runAdmin(['set-channel-allowfrom', '1234567890'], harness.options)).toBe(1);
    expect(harness.stderr.text).toContain('allowFrom requires at least one entry');
    expect(runAdmin(['set-channel-allowfrom', '1234567890', 'not-id'], harness.options)).toBe(1);
    expect(runAdmin(['set-channel-allowfrom', '9999999999', '1111111111'], harness.options)).toBe(1);
    expect(harness.stderr.text).toContain('channel not configured; add-channel first');
    expect(harness.config.channels['1234567890'].allowFrom).toEqual(['1111111111']);
  });

  it('writes allowFrom semantics that auth reads consistently', () => {
    const harness = makeHarness({
      owner: '1111111111',
      channels: {
        1234567890: { name: 'ops', mode: 'mention', allowFrom: [] }
      }
    });

    expect(runAdmin(['set-channel-allowfrom', '1234567890', '*'], harness.options)).toBe(0);
    expect(isSenderAllowed(harness.config, '1234567890', '2222222222')).toBe(true);

    expect(runAdmin(['set-channel-allowfrom', '1234567890', '1111111111'], harness.options)).toBe(0);
    expect(isSenderAllowed(harness.config, '1234567890', '1111111111')).toBe(true);
    expect(isSenderAllowed(harness.config, '1234567890', '2222222222')).toBe(false);
  });

  it('treats group command aliases as channel command equivalents', () => {
    const cases = [
      {
        alias: ['add-group', '2222222222', 'ops', 'smart'],
        canonical: ['add-channel', '2222222222', 'ops', 'smart'],
        initial: { owner: '1111111111', channels: {} }
      },
      {
        alias: ['set-group-mode', '1234567890', 'smart'],
        canonical: ['set-channel-mode', '1234567890', 'smart'],
        initial: { channels: { 1234567890: { name: 'ops', mode: 'mention' } } }
      },
      {
        alias: ['set-group-allowfrom', '1234567890', '1111111111', '*'],
        canonical: ['set-channel-allowfrom', '1234567890', '1111111111', '*'],
        initial: { channels: { 1234567890: { name: 'ops', mode: 'mention', allowFrom: [] } } }
      },
      {
        alias: ['add-group-allow', '1234567890', '2222222222'],
        canonical: ['add-channel-allow', '1234567890', '2222222222'],
        initial: { channels: { 1234567890: { name: 'ops', mode: 'mention', allowFrom: [] } } }
      },
      {
        alias: ['remove-group-allow', '1234567890', '2222222222'],
        canonical: ['remove-channel-allow', '1234567890', '2222222222'],
        initial: { channels: { 1234567890: { name: 'ops', mode: 'mention', allowFrom: ['2222222222'] } } }
      },
      {
        alias: ['set-group-history-limit', '1234567890', '12'],
        canonical: ['set-channel-history-limit', '1234567890', '12'],
        initial: { channels: { 1234567890: { name: 'ops', mode: 'mention' } } }
      },
      {
        alias: ['remove-group', '1234567890'],
        canonical: ['remove-channel', '1234567890'],
        initial: { channels: { 1234567890: { name: 'ops', mode: 'mention' } } }
      },
      {
        alias: ['list-groups'],
        canonical: ['list-channels'],
        initial: { channels: { 1234567890: { name: 'ops', mode: 'mention' } } }
      },
      {
        alias: ['list-group-allow', '1234567890'],
        canonical: ['list-channel-allow', '1234567890'],
        initial: { channels: { 1234567890: { name: 'ops', mode: 'mention', allowFrom: ['1111111111'] } } }
      }
    ];

    for (const item of cases) {
      const aliasHarness = makeHarness(item.initial);
      const canonicalHarness = makeHarness(item.initial);
      expect(runAdmin(item.alias, aliasHarness.options)).toBe(runAdmin(item.canonical, canonicalHarness.options));
      expect(aliasHarness.config).toEqual(canonicalHarness.config);
      expect(aliasHarness.stdout.text).toBe(canonicalHarness.stdout.text);
      expect(aliasHarness.stderr.text).toBe(canonicalHarness.stderr.text);
    }
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
    expect(runAdmin(['set-thread-mode', '1234567890', 'bad-id', 'smart'], harness.options)).toBe(1);
    expect(runAdmin(['set-channel-reaction-notify', '1234567890', 'mentions'], harness.options)).toBe(1);
    expect(runAdmin(['set-channel-allowfrom', '1234567890', 'bad-id'], harness.options)).toBe(1);
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
          threads: {
            9876543210: { mode: 'smart' }
          },
          historyLimit: 9,
          reactionNotifyMode: 'all'
        }
      }
    });

    expect(runAdmin(['list-channels'], harness.options)).toBe(0);
    expect(harness.stdout.text).toContain('1234567890 - ops');
    expect(harness.stdout.text).toContain('thread 9876543210: mode=smart');
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
    expect(harness.stdout.text).toContain('set-dm-policy <open|allowlist|owner|pairing>');
    expect(harness.stdout.text).toContain('dm-pending');
    expect(harness.stdout.text).toContain('dm-approve <userId>');
    expect(harness.stdout.text).toContain('set-channel-allowfrom');
    expect(harness.stdout.text).toContain('set-group-allowfrom');
    expect(harness.stdout.text).toContain('set-channel-reaction-notify');
    expect(harness.stdout.text).toContain('set-thread-mode');
    expect(harness.stdout.text).toContain('Changes apply live');
  });
});
