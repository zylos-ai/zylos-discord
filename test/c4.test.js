import { describe, expect, it } from 'vitest';
import {
  buildEventEndpoint,
  buildEndpoint,
  escapeXml,
  formatDmMessage,
  formatGroupMessage,
  formatMessageDeleteEvent,
  formatMessageEditEvent,
  formatReactionEvent,
  parseEndpoint,
  normalizeCorrelationPart
} from '../src/lib/c4.js';

describe('c4 helpers', () => {
  it('builds and parses DM endpoints', () => {
    const endpoint = buildEndpoint('channel123', { messageId: 'msg456' });
    expect(endpoint).toBe('channel123|msg:msg456|req:channel123:msg456');
    expect(parseEndpoint(endpoint)).toEqual({
      channelId: 'channel123',
      msg: 'msg456',
      req: 'channel123:msg456'
    });
  });

  it('parses endpoints without optional fields', () => {
    expect(parseEndpoint('channel123')).toEqual({
      channelId: 'channel123',
      msg: null,
      req: null
    });
  });

  it('builds unique event endpoints while preserving reply threading target', () => {
    const first = parseEndpoint(buildEventEndpoint('chan1', {
      messageId: 'msg1',
      kind: 'reaction:added:💡:user1',
      now: 12345,
      nonce: 'nonce1'
    }));
    const second = parseEndpoint(buildEventEndpoint('chan1', {
      messageId: 'msg1',
      kind: 'reaction:added:💡:user1',
      now: 12345,
      nonce: 'nonce2'
    }));

    expect(first.channelId).toBe('chan1');
    expect(first.msg).toBe('msg1');
    expect(first.req).toBe('chan1:msg1:reaction:added:_:user1:12345:nonce1');
    expect(second.req).toBe('chan1:msg1:reaction:added:_:user1:12345:nonce2');
    expect(first.req).not.toBe(second.req);
  });

  it('normalizes correlation parts for endpoint-safe reaction keys', () => {
    expect(normalizeCorrelationPart('<:ok:123>')).toBe('_:ok:123_');
    expect(normalizeCorrelationPart('')).toBe('event');
  });

  it('escapes XML-sensitive characters', () => {
    expect(escapeXml(`&<>'"`)).toBe('&amp;&lt;&gt;&apos;&quot;');
  });

  it('formats DM messages with escaped username and content', () => {
    const result = formatDmMessage({
      username: 'A&B',
      text: '<hello>',
      filePath: '/tmp/a&b.png',
      replyingTo: {
        messageId: 'm"1',
        fromUserId: 'u&1',
        text: '<quoted>'
      }
    });

    expect(result).toContain('[DISCORD DM] A&amp;B said:');
    expect(result).toContain('<replying-to message-id="m&quot;1" from-user-id="u&amp;1">&lt;quoted&gt;</replying-to>');
    expect(result.indexOf('<replying-to')).toBeLessThan(result.indexOf('<current-message>'));
    expect(result).toContain('&lt;hello&gt;');
    expect(result).toContain('<current-message>');
    expect(result).toContain('</current-message>');
    expect(result).toContain('---- file: /tmp/a&amp;b.png');
  });

  it('formats multiple file trailers while keeping single-path callers working', () => {
    const result = formatDmMessage({
      username: 'Felix',
      text: 'files',
      filePath: ['/tmp/a&b.png', '/tmp/c<d>.txt']
    });

    expect(result).toContain('<current-message>\nfiles\n</current-message>');
    expect(result).toContain('---- file: /tmp/a&amp;b.png\n---- file: /tmp/c&lt;d&gt;.txt');
  });

  it('formats group messages with escaped context', () => {
    const result = formatGroupMessage({
      channelName: 'team<&>',
      username: 'A&B',
      text: '<hello>',
      history: [
        { direction: 'in', username: 'C<D', text: 'prev' },
        { direction: 'out', text: 'reply & more' }
      ],
      filePath: '/tmp/group<file>.txt',
      replyingTo: {
        messageId: 'parent1',
        fromUserId: 'author1',
        text: 'quoted body'
      }
    });

    expect(result).toContain('[DISCORD GROUP:team&lt;&amp;&gt;] A&amp;B said:');
    expect(result).toContain('<group-context>');
    expect(result).toContain('[C&lt;D]: prev');
    expect(result).toContain('[bot]: reply &amp; more');
    expect(result).toContain('<replying-to message-id="parent1" from-user-id="author1">quoted body</replying-to>');
    expect(result).toContain('&lt;hello&gt;');
    expect(result).toContain('---- file: /tmp/group&lt;file&gt;.txt');
  });

  it('formats group messages with multiple file trailers', () => {
    const result = formatGroupMessage({
      channelName: 'files',
      username: 'Felix',
      text: '[sent a file: one.txt] [sent a file: two.txt]',
      filePath: ['/tmp/one.txt', '/tmp/two.txt']
    });

    expect(result).toContain('[DISCORD GROUP:files] Felix said:');
    expect(result).toContain('[sent a file: one.txt] [sent a file: two.txt]');
    expect(result).toContain('---- file: /tmp/one.txt\n---- file: /tmp/two.txt');
  });

  it('formats thread messages with smart-mode hints', () => {
    const result = formatGroupMessage({
      channelName: 'parent / thread',
      username: 'Felix',
      text: 'needs attention',
      isThread: true,
      smartHint: true
    });

    expect(result).toContain('[DISCORD THREAD:parent / thread] Felix said:');
    expect(result).toContain('<smart-mode>');
    expect(result).toContain('[SKIP]');
    expect(result).not.toContain('<group-context>');
  });

  it('keeps voice transcript inline while retaining file path', () => {
    const result = formatDmMessage({
      username: 'Felix',
      text: '[Voice] hello from audio',
      filePath: '/tmp/voice.ogg'
    });

    expect(result).toContain('<current-message>\n[Voice] hello from audio\n</current-message>');
    expect(result).toContain('---- file: /tmp/voice.ogg');
  });

  it('omits reply context when no reference is provided', () => {
    const result = formatGroupMessage({
      channelName: 'general',
      username: 'Felix',
      text: 'hello'
    });

    expect(result).not.toContain('<replying-to');
  });

  it('caps reply context body length', () => {
    const result = formatDmMessage({
      username: 'Felix',
      text: 'current',
      replyingTo: {
        messageId: 'parent1',
        fromUserId: 'user1',
        text: 'a'.repeat(150)
      }
    });

    const body = result.match(/<replying-to [^>]+>([^<]+)<\/replying-to>/)?.[1];
    expect(body).toHaveLength(100);
    expect(body.endsWith('...')).toBe(true);
  });


  it('formats inbound event notices with escaped and shortened content', () => {
    expect(formatReactionEvent({
      username: 'A&B',
      action: 'added',
      emoji: '<:ok:1>',
      targetText: '<target>'
    })).toBe('[DISCORD REACTION] A&amp;B added &lt;:ok:1&gt; to "&lt;target&gt;"');

    expect(formatMessageDeleteEvent({
      username: 'E>F',
      text: 'gone'
    })).toBe('[DISCORD DELETE] E&gt;F deleted a message: "gone"');
  });

  it('formats message edits with full current text and no before text', () => {
    const current = `${'a'.repeat(150)} & more`;
    const result = formatMessageEditEvent({
      username: 'C<D',
      oldText: 'old text should not appear',
      newText: current
    });

    expect(result).toBe(`[DISCORD EDIT] C&lt;D edited their message - current text: "${'a'.repeat(150)} &amp; more"`);
    expect(result).not.toContain('old text');
  });

  it('caps message edit current text at 4000 chars, not 120', () => {
    const longText = 'x'.repeat(5000);
    const result = formatMessageEditEvent({
      username: 'Felix',
      newText: longText
    });
    const body = result.match(/current text: "([^"]+)"/)?.[1];

    expect(body).toHaveLength(4000);
    expect(body.endsWith('...')).toBe(true);
    expect(body).toContain('x'.repeat(200));
  });
});
