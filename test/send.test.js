import { describe, expect, it } from 'vitest';
import { splitMessage } from '../scripts/send.js';

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
});
