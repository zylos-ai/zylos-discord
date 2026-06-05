import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function functionBody(source, name) {
  const marker = `async function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) return '';

  const paramsOpen = source.indexOf('(', start);
  let parenDepth = 0;
  let open = -1;
  for (let i = paramsOpen; i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    if (source[i] === ')') parenDepth -= 1;
    if (parenDepth === 0) {
      open = source.indexOf('{', i);
      break;
    }
  }
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(open, i + 1);
  }
  return '';
}

describe('index hot-path config use', () => {
  it('uses cached config snapshots in gateway event handlers', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/index.js'), 'utf8');
    const handlers = [
      'handleReactionEvent',
      'handleMessageUpdate',
      'handleMessageDelete',
      'handleGuildMessage',
      'handleDirectMessage'
    ];

    for (const handler of handlers) {
      const body = functionBody(source, handler);
      expect(body, `${handler} should exist`).not.toBe('');
      expect(body, `${handler} should not force config reloads`).not.toContain('loadConfig(');
      expect(body, `${handler} should read cached config`).toContain('getConfig(');
    }
  });

  it('starts response indicators before inbound media and voice resolution', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/index.js'), 'utf8');

    for (const handler of ['handleGuildMessage', 'handleDirectMessage']) {
      const body = functionBody(source, handler);
      const reactionIndex = body.indexOf('setReaction(message)');
      const typingIndex = body.indexOf('startTyping(message.channel, correlationId)');
      const mediaIndex = body.indexOf('resolveInboundAttachments(');

      expect(reactionIndex, `${handler} should set a reaction`).toBeGreaterThanOrEqual(0);
      expect(typingIndex, `${handler} should start typing`).toBeGreaterThanOrEqual(0);
      expect(mediaIndex, `${handler} should resolve inbound attachments`).toBeGreaterThanOrEqual(0);
      expect(reactionIndex, `${handler} reaction should precede media resolution`).toBeLessThan(mediaIndex);
      expect(typingIndex, `${handler} typing should precede media resolution`).toBeLessThan(mediaIndex);
    }
  });

  it('processes all inbound attachments through a capped multi-attachment path', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/index.js'), 'utf8');
    const resolver = functionBody(source, 'resolveInboundAttachments');

    expect(source).toContain('const MAX_ATTACHMENTS_PER_MESSAGE = 10;');
    expect(resolver).toContain('attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)');
    expect(resolver).toContain('more attachments not processed');
    expect(resolver).toContain('for (const attachment of processed)');
    expect(resolver).toContain('resolveInboundMedia(config, attachment');

    for (const handler of ['handleGuildMessage', 'handleDirectMessage']) {
      const body = functionBody(source, handler);
      expect(body).toContain('resolveInboundAttachments(config, attachments');
      expect(body).not.toContain('attachments[0]');
    }
  });
});
