import { describe, expect, it } from 'vitest';
import {
  bindOwnerIfUnset,
  hasOwner,
  isChannelAllowed,
  isDmAuthorized,
  isOwner,
  resolveGuildAccess,
  isSenderAllowed,
  isSmartChannel
} from '../src/lib/auth.js';

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
    expect(isDmAuthorized({ owner: '1', dmPolicy: 'pairing', dmAllowFrom: [2] }, '2')).toBe(true);
    expect(isDmAuthorized({ owner: '1', dmPolicy: 'pairing', dmAllowFrom: ['3'] }, '2')).toBe(false);
    expect(isDmAuthorized({ owner: '1', dmPolicy: 'pairing', dmAllowFrom: [] }, '1')).toBe(true);
  });

  it('authorizes configured guild channels only when group policy is enabled', () => {
    const config = {
      groupPolicy: 'allowlist',
      channels: {
        parent1: { mode: 'mention' },
        parent2: { mode: 'smart' }
      }
    };

    expect(isChannelAllowed(config, 'parent1')).toBe(true);
    expect(isChannelAllowed(config, 'missing')).toBe(false);
    expect(isSmartChannel(config, 'parent1')).toBe(false);
    expect(isSmartChannel(config, 'parent2')).toBe(true);
    expect(isChannelAllowed({ ...config, groupPolicy: 'disabled' }, 'parent1')).toBe(false);
    expect(isSmartChannel({ ...config, groupPolicy: 'disabled' }, 'parent2')).toBe(false);
  });

  it('honors open group policy for unconfigured channels without making them smart', () => {
    const config = {
      groupPolicy: 'open',
      channels: {
        parent1: { mode: 'smart' }
      }
    };

    expect(isChannelAllowed(config, 'missing')).toBe(true);
    expect(isSmartChannel(config, 'missing')).toBe(false);
    expect(resolveGuildAccess(config, 'missing', 'user1')).toMatchObject({
      ok: true,
      owner: false,
      allowed: true,
      smart: false
    });
    expect(resolveGuildAccess({ ...config, groupPolicy: 'disabled' }, 'missing', 'user1')).toMatchObject({
      ok: false,
      owner: false,
      allowed: false,
      smart: false
    });
  });

  it('authorizes guild senders with empty allowFrom as anyone', () => {
    expect(isSenderAllowed({ channels: { c1: {} } }, 'c1', 'user1')).toBe(true);
    expect(isSenderAllowed({ channels: { c1: { allowFrom: ['*'] } } }, 'c1', 'user1')).toBe(true);
    expect(isSenderAllowed({ channels: { c1: { allowFrom: [123] } } }, 'c1', '123')).toBe(true);
    expect(isSenderAllowed({ channels: { c1: { allowFrom: ['abc'] } } }, 'c1', '123')).toBe(false);
  });

  it('uses per-thread smart mode overrides without changing parent access gates', () => {
    const config = {
      owner: 'owner1',
      groupPolicy: 'allowlist',
      channels: {
        parent1: {
          mode: 'mention',
          allowFrom: ['user1'],
          threads: {
            thread1: { mode: 'smart' }
          }
        },
        parent2: {
          mode: 'smart',
          allowFrom: ['user1'],
          threads: {
            thread2: { mode: 'mention' }
          }
        }
      }
    };

    expect(isSmartChannel(config, 'parent1', 'thread1')).toBe(true);
    expect(isSmartChannel(config, 'parent1', 'unknown')).toBe(false);
    expect(isSmartChannel(config, 'parent2', 'thread2')).toBe(false);
    expect(resolveGuildAccess(config, 'parent1', 'user1', 'thread1')).toMatchObject({
      ok: true,
      owner: false,
      allowed: true,
      smart: true
    });
    expect(resolveGuildAccess(config, 'parent1', 'user2', 'thread1')).toMatchObject({
      ok: false,
      owner: false,
      allowed: true,
      smart: true
    });
  });

  it('lets the owner bypass disabled guild policy without opening it to non-owners', () => {
    const config = {
      owner: 'owner1',
      groupPolicy: 'disabled',
      channels: {
        guild1: { mode: 'mention' }
      }
    };

    expect(resolveGuildAccess(config, 'guild1', 'owner1')).toMatchObject({
      ok: true,
      owner: true,
      allowed: false,
      smart: false
    });
    expect(resolveGuildAccess(config, 'guild1', 'user1')).toMatchObject({
      ok: false,
      owner: false,
      allowed: false,
      smart: false
    });
  });

  it('preserves allowlist, smart, and sender gates for non-owners', () => {
    const config = {
      owner: 'owner1',
      groupPolicy: 'allowlist',
      channels: {
        mention: { mode: 'mention', allowFrom: ['user1'] },
        smart: { mode: 'smart' },
        blocked: { mode: 'mention', allowFrom: ['other'] }
      }
    };

    expect(resolveGuildAccess(config, 'mention', 'user1')).toMatchObject({
      ok: true,
      owner: false,
      allowed: true,
      smart: false
    });
    expect(resolveGuildAccess(config, 'smart', 'user2')).toMatchObject({
      ok: true,
      owner: false,
      allowed: true,
      smart: true
    });
    expect(resolveGuildAccess(config, 'blocked', 'user1')).toMatchObject({
      ok: false,
      owner: false,
      allowed: true,
      smart: false
    });
  });
});
