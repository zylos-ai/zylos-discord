import { describe, expect, it } from 'vitest';
import { buildEndpoint, escapeXml, formatDmMessage, parseEndpoint } from '../src/lib/c4.js';

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
      text: '<hello>'
    });

    expect(result).toContain('[DISCORD DM] A&amp;B said:');
    expect(result).toContain('&lt;hello&gt;');
    expect(result).toContain('<current-message>');
    expect(result).toContain('</current-message>');
  });
});
