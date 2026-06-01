import { describe, expect, it } from 'vitest';
import { bindOwnerIfUnset, hasOwner, isDmAuthorized, isOwner } from '../src/lib/auth.js';

describe('auth', () => {
  it('normalizes owner id comparisons', () => {
    expect(isOwner({ owner: 123 }, '123')).toBe(true);
    expect(isOwner({ owner: '123' }, 123)).toBe(true);
    expect(isOwner({ owner: '123' }, '456')).toBe(false);
  });

  it('binds owner only when unset', () => {
    const config = { owner: null };
    expect(hasOwner(config)).toBe(false);
    expect(bindOwnerIfUnset(config, 123)).toBe(true);
    expect(config.owner).toBe('123');
    expect(bindOwnerIfUnset(config, 456)).toBe(false);
    expect(config.owner).toBe('123');
  });

  it('authorizes DMs by policy', () => {
    expect(isDmAuthorized({ owner: '1', dmPolicy: 'owner' }, '1')).toBe(true);
    expect(isDmAuthorized({ owner: '1', dmPolicy: 'owner' }, '2')).toBe(false);
    expect(isDmAuthorized({ owner: '1', dmPolicy: 'open' }, '2')).toBe(true);
    expect(isDmAuthorized({ owner: '1', dmPolicy: 'allowlist', dmAllowFrom: [2] }, '2')).toBe(true);
    expect(isDmAuthorized({ owner: '1', dmPolicy: 'allowlist', dmAllowFrom: ['3'] }, '2')).toBe(false);
  });
});
