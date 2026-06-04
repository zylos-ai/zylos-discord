import { describe, expect, it, vi } from 'vitest';
import {
  autoRegisterOwnerMentionedChannel,
  isBotMentioned,
  resolvePolicyChannelId,
  resolvePolicyThreadId
} from '../src/lib/guild-access.js';
import { resolveGuildAccess } from '../src/lib/auth.js';

function guildMessage({
  channelId = '2222222222',
  parentId = null,
  thread = false,
  channelName = 'ops',
  parentName = 'forum',
  authorId = '1111111111',
  mention = true
} = {}) {
  return {
    author: { id: authorId },
    channel: {
      id: channelId,
      name: channelName,
      parentId,
      parent: parentId ? { id: parentId, name: parentName } : null,
      isThread: () => thread
    },
    mentions: {
      has: vi.fn((user) => mention && user?.id === 'bot1'),
      users: new Map(mention ? [['bot1', { id: 'bot1' }]] : [])
    }
  };
}

describe('guild access helpers', () => {
  it('resolves policy ids for channels and threads', () => {
    expect(resolvePolicyChannelId(guildMessage())).toBe('2222222222');
    expect(resolvePolicyThreadId(guildMessage())).toBeNull();
    expect(resolvePolicyChannelId(guildMessage({
      channelId: '3333333333',
      parentId: '2222222222',
      thread: true
    }))).toBe('2222222222');
    expect(resolvePolicyThreadId(guildMessage({
      channelId: '3333333333',
      parentId: '2222222222',
      thread: true
    }))).toBe('3333333333');
  });

  it('detects bot mentions by user object or user map', () => {
    expect(isBotMentioned(guildMessage({ mention: true }), { id: 'bot1' })).toBe(true);
    expect(isBotMentioned(guildMessage({ mention: false }), { id: 'bot1' })).toBe(false);
  });

  it('auto-registers an unconfigured parent channel on first owner mention', async () => {
    const config = {
      owner: '1111111111',
      groupPolicy: 'allowlist',
      channels: {}
    };
    const saveConfig = vi.fn(() => true);
    const notifyOwner = vi.fn(async () => {});

    await expect(autoRegisterOwnerMentionedChannel({
      config,
      message: guildMessage(),
      clientUser: { id: 'bot1' },
      saveConfig,
      notifyOwner
    })).resolves.toMatchObject({
      registered: true,
      notified: true,
      policyChannelId: '2222222222',
      channelName: 'ops'
    });

    expect(config.channels['2222222222']).toEqual({
      name: 'ops',
      mode: 'mention',
      allowFrom: ['1111111111']
    });
    expect(saveConfig).toHaveBeenCalledOnce();
    expect(notifyOwner).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: '1111111111',
      policyChannelId: '2222222222'
    }));
    expect(resolveGuildAccess(config, '2222222222', '1111111111').ok).toBe(true);
    expect(resolveGuildAccess(config, '2222222222', '3333333333').ok).toBe(false);
  });

  it('does not auto-register twice or for non-owner mentions', async () => {
    const config = {
      owner: '1111111111',
      groupPolicy: 'allowlist',
      channels: {
        2222222222: { name: 'ops', mode: 'mention', allowFrom: ['1111111111'] }
      }
    };
    const saveConfig = vi.fn(() => true);

    await expect(autoRegisterOwnerMentionedChannel({
      config,
      message: guildMessage(),
      clientUser: { id: 'bot1' },
      saveConfig
    })).resolves.toMatchObject({ registered: false });

    delete config.channels['2222222222'];
    await expect(autoRegisterOwnerMentionedChannel({
      config,
      message: guildMessage({ authorId: '3333333333' }),
      clientUser: { id: 'bot1' },
      saveConfig
    })).resolves.toMatchObject({ registered: false });

    expect(config.channels).toEqual({});
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('registers a thread mention against the parent container', async () => {
    const config = {
      owner: '1111111111',
      groupPolicy: 'allowlist',
      channels: {}
    };

    await expect(autoRegisterOwnerMentionedChannel({
      config,
      message: guildMessage({
        channelId: '3333333333',
        parentId: '2222222222',
        thread: true,
        channelName: 'incident',
        parentName: 'ops-forum'
      }),
      clientUser: { id: 'bot1' },
      saveConfig: vi.fn(() => true)
    })).resolves.toMatchObject({
      registered: true,
      policyChannelId: '2222222222',
      channelName: 'ops-forum'
    });

    expect(config.channels).toEqual({
      2222222222: {
        name: 'ops-forum',
        mode: 'mention',
        allowFrom: ['1111111111']
      }
    });
  });
});
