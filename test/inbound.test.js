import { describe, expect, it, vi } from 'vitest';
import { THINKING_REACTION } from '../src/lib/reactions.js';
import {
  fetchIfPartial,
  getStickers,
  resolveReplyContext,
  shouldDownloadInboundMedia,
  shouldForwardMessageDelete,
  shouldForwardMessageUpdate,
  shouldForwardReaction,
  stickersNote
} from '../src/lib/inbound.js';

function guildMessage({
  id = 'm1',
  channelId = 'chan1',
  parentId = null,
  thread = false,
  authorId = 'user1',
  bot = false,
  content = 'hello',
  cleanContent = null
} = {}) {
  return {
    id,
    content,
    cleanContent,
    author: { id: authorId, username: authorId, bot },
    channel: {
      id: channelId,
      parentId,
      isDMBased: () => false,
      isThread: () => thread
    },
    inGuild: () => true
  };
}

function dmMessage({
  id = 'dm1',
  channelId = 'dmchan',
  authorId = 'user1',
  bot = false,
  content = 'hello'
} = {}) {
  return {
    id,
    content,
    author: { id: authorId, username: authorId, bot },
    channel: {
      id: channelId,
      isDMBased: () => true
    },
    inGuild: () => false
  };
}

function config(overrides = {}) {
  return {
    owner: 'owner1',
    dmPolicy: 'allowlist',
    dmAllowFrom: ['user1'],
    groupPolicy: 'allowlist',
    channels: {
      chan1: { mode: 'mention' }
    },
    reactionNotifyMode: 'own',
    ...overrides
  };
}

describe('inbound helpers', () => {
  it('resolves reply context from referenced messages', async () => {
    const fetchReference = vi.fn(async () => guildMessage({
      id: 'parent1',
      authorId: 'parent-user',
      content: '<quoted & body>'
    }));

    await expect(resolveReplyContext({
      reference: { messageId: 'parent1' },
      fetchReference
    })).resolves.toEqual({
      messageId: 'parent1',
      fromUserId: 'parent-user',
      text: '<quoted & body>'
    });
    expect(fetchReference).toHaveBeenCalledOnce();
  });

  it('omits reply context without references or when fetch fails', async () => {
    await expect(resolveReplyContext({})).resolves.toBeNull();
    await expect(resolveReplyContext({
      reference: { messageId: 'parent1' },
      fetchReference: vi.fn(async () => { throw new Error('missing'); })
    })).resolves.toBeNull();
  });

  it('fetches partial entities gracefully', async () => {
    const fetched = { id: 'fetched' };
    await expect(fetchIfPartial({ partial: false, id: 'cached' })).resolves.toMatchObject({ id: 'cached' });
    await expect(fetchIfPartial({ partial: true, fetch: vi.fn(async () => fetched) })).resolves.toBe(fetched);
    await expect(fetchIfPartial({ partial: true, fetch: vi.fn(async () => { throw new Error('gone'); }) })).resolves.toBeNull();
  });

  it('keeps media and voice downloads behind the existing response gate', () => {
    expect(shouldDownloadInboundMedia({
      shouldRespond: true,
      hasAttachment: true,
      downloadMediaEnabled: true,
      smartNoMention: false
    })).toBe(true);

    expect(shouldDownloadInboundMedia({
      shouldRespond: false,
      hasAttachment: true,
      downloadMediaEnabled: true,
      smartNoMention: false
    })).toBe(false);

    expect(shouldDownloadInboundMedia({
      shouldRespond: true,
      hasAttachment: true,
      downloadMediaEnabled: false,
      smartNoMention: false
    })).toBe(false);

    expect(shouldDownloadInboundMedia({
      shouldRespond: true,
      hasAttachment: true,
      downloadMediaEnabled: true,
      smartNoMention: true
    })).toBe(false);
  });

  it('formats inbound sticker notes from Discord sticker collections', () => {
    const stickers = new Map([
      ['s1', { id: 's1', name: 'party <cat>' }],
      ['s2', { id: 's2', name: 'wave' }]
    ]);

    expect(getStickers({ stickers })).toEqual([
      { id: 's1', name: 'party <cat>' },
      { id: 's2', name: 'wave' }
    ]);
    expect(stickersNote(getStickers({ stickers }))).toBe('[sticker: party <cat>] [+1 more stickers]');
    expect(stickersNote([{ id: 's3' }])).toBe('[sticker: s3]');
    expect(stickersNote([])).toBeNull();
  });

  it('forwards own-message reactions in own mode', () => {
    expect(shouldForwardReaction({
      config: config(),
      reaction: {
        emoji: { toString: () => ':ok:' },
        message: guildMessage({ authorId: 'bot1', content: 'bot reply' })
      },
      user: { id: 'user1', username: 'Felix' },
      clientUserId: 'bot1'
    })).toBe(true);
  });

  it('forwards non-bot-message reactions in all mode', () => {
    expect(shouldForwardReaction({
      config: config({ reactionNotifyMode: 'all' }),
      reaction: {
        emoji: { toString: () => ':ok:' },
        message: guildMessage({ authorId: 'user2', content: 'user post' })
      },
      user: { id: 'user1', username: 'Felix' },
      clientUserId: 'bot1'
    })).toBe(true);
  });

  it('uses per-channel reaction notify mode over the global default', () => {
    expect(shouldForwardReaction({
      config: config({
        reactionNotifyMode: 'own',
        channels: {
          chan1: { mode: 'mention', reactionNotifyMode: 'all' }
        }
      }),
      reaction: {
        emoji: { toString: () => ':ok:' },
        message: guildMessage({ authorId: 'user2', content: 'user post' })
      },
      user: { id: 'user1', username: 'Felix' },
      clientUserId: 'bot1'
    })).toBe(true);
  });

  it('suppresses bot reactions, thinking reactions, off mode, and blocked channels', () => {
    const baseReaction = {
      emoji: { toString: () => ':ok:' },
      message: guildMessage({ authorId: 'bot1' })
    };

    expect(shouldForwardReaction({
      config: config(),
      reaction: baseReaction,
      user: { id: 'bot1', username: 'bot' },
      clientUserId: 'bot1'
    })).toBe(false);

    expect(shouldForwardReaction({
      config: config(),
      reaction: { ...baseReaction, emoji: { toString: () => THINKING_REACTION } },
      user: { id: 'user1', username: 'Felix' },
      clientUserId: 'bot1'
    })).toBe(false);

    expect(shouldForwardReaction({
      config: config({ reactionNotifyMode: 'off' }),
      reaction: baseReaction,
      user: { id: 'user1', username: 'Felix' },
      clientUserId: 'bot1'
    })).toBe(false);

    expect(shouldForwardReaction({
      config: config({ channels: {} }),
      reaction: baseReaction,
      user: { id: 'user1', username: 'Felix' },
      clientUserId: 'bot1'
    })).toBe(false);
  });

  it('forwards message content edits and ignores embed-only updates', () => {
    expect(shouldForwardMessageUpdate({
      config: config(),
      oldMessage: guildMessage({ content: 'old' }),
      newMessage: guildMessage({ content: 'new' }),
      clientUserId: 'bot1'
    })).toBe(true);

    expect(shouldForwardMessageUpdate({
      config: config(),
      oldMessage: guildMessage({ content: 'same' }),
      newMessage: guildMessage({ content: 'same' }),
      clientUserId: 'bot1'
    })).toBe(false);
  });

  it('uses the parent forum channel for thread access gates', () => {
    expect(shouldForwardMessageUpdate({
      config: config({
        channels: {
          forum1: { mode: 'mention' }
        }
      }),
      oldMessage: guildMessage({
        channelId: 'thread1',
        parentId: 'forum1',
        thread: true,
        content: 'old'
      }),
      newMessage: guildMessage({
        channelId: 'thread1',
        parentId: 'forum1',
        thread: true,
        content: 'new'
      }),
      clientUserId: 'bot1'
    })).toBe(true);

    expect(shouldForwardMessageUpdate({
      config: config({ channels: {} }),
      oldMessage: guildMessage({
        channelId: 'thread1',
        parentId: 'forum1',
        thread: true,
        content: 'old'
      }),
      newMessage: guildMessage({
        channelId: 'thread1',
        parentId: 'forum1',
        thread: true,
        content: 'new'
      }),
      clientUserId: 'bot1'
    })).toBe(false);
  });

  it('suppresses bot edits and gated edits', () => {
    expect(shouldForwardMessageUpdate({
      config: config(),
      oldMessage: guildMessage({ authorId: 'bot1', bot: true, content: 'old' }),
      newMessage: guildMessage({ authorId: 'bot1', bot: true, content: 'new' }),
      clientUserId: 'bot1'
    })).toBe(false);

    expect(shouldForwardMessageUpdate({
      config: config({ channels: {} }),
      oldMessage: guildMessage({ content: 'old' }),
      newMessage: guildMessage({ content: 'new' }),
      clientUserId: 'bot1'
    })).toBe(false);
  });

  it('forwards deletes for authorized messages and suppresses bot or blocked deletes', () => {
    expect(shouldForwardMessageDelete({
      config: config(),
      message: dmMessage({ authorId: 'user1', content: 'gone' }),
      clientUserId: 'bot1'
    })).toBe(true);

    expect(shouldForwardMessageDelete({
      config: config(),
      message: guildMessage({ authorId: 'bot1', bot: true, content: 'gone' }),
      clientUserId: 'bot1'
    })).toBe(false);

    expect(shouldForwardMessageDelete({
      config: config({ channels: {} }),
      message: guildMessage({ content: 'gone' }),
      clientUserId: 'bot1'
    })).toBe(false);
  });
});
