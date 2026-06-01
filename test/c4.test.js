import { describe, expect, it } from 'vitest';
import { buildEndpoint, escapeXml, formatDmMessage, formatGroupMessage, parseEndpoint } from '../src/lib/c4.js';

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

  it('escapes XML-sensitive characters', () => {
    expect(escapeXml(`&<>'"`)).toBe('&amp;&lt;&gt;&apos;&quot;');
  });

  it('formats DM messages with escaped username and content', () => {
    const result = formatDmMessage({
      username: 'A&B',
      text: '<hello>',
      filePath: '/tmp/a&b.png'
    });

    expect(result).toContain('[DISCORD DM] A&amp;B said:');
    expect(result).toContain('&lt;hello&gt;');
    expect(result).toContain('<current-message>');
    expect(result).toContain('</current-message>');
    expect(result).toContain('---- file: /tmp/a&amp;b.png');
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
      filePath: '/tmp/group<file>.txt'
    });

    expect(result).toContain('[DISCORD GROUP:team&lt;&amp;&gt;] A&amp;B said:');
    expect(result).toContain('<group-context>');
    expect(result).toContain('[C&lt;D]: prev');
    expect(result).toContain('[bot]: reply &amp; more');
    expect(result).toContain('&lt;hello&gt;');
    expect(result).toContain('---- file: /tmp/group&lt;file&gt;.txt');
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
});
