import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMediaMessage, splitMessage, validateMediaFile } from '../scripts/send.js';

describe('send helpers', () => {
  it('splits messages at boundaries and skips empty chunks', () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}\n\n${'c'.repeat(50)}`;
    const chunks = splitMessage(text, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks.every((chunk) => chunk.trim().length > 0)).toBe(true);
  });

  it('returns no chunks for empty text', () => {
    expect(splitMessage('', 10)).toEqual([]);
    expect(splitMessage('   ', 10)).toEqual([]);
  });

  it('parses supported media messages only', () => {
    expect(parseMediaMessage('[MEDIA:image]/tmp/a.png')).toEqual({ kind: 'image', filePath: '/tmp/a.png' });
    expect(parseMediaMessage('[MEDIA:file]  /tmp/a.pdf  ')).toEqual({ kind: 'file', filePath: '/tmp/a.pdf' });
    expect(parseMediaMessage('[MEDIA:audio]/tmp/a.mp3')).toBeNull();
    expect(parseMediaMessage('[MEDIA:file]   ')).toBeNull();
  });

  it('validates outbound media paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-send-media-'));
    const filePath = path.join(dir, 'file.txt');
    fs.writeFileSync(filePath, 'ok');

    expect(validateMediaFile(filePath).isFile()).toBe(true);
    expect(() => validateMediaFile(path.join(dir, 'missing.txt'))).toThrow('file not found');
    expect(() => validateMediaFile(dir)).toThrow('media path is not a file');
    expect(() => validateMediaFile(filePath, 1)).toThrow('file exceeds 10MB');
  });
});
