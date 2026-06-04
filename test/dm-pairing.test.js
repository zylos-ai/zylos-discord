import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approvePairingUser,
  denyPairingUser,
  getPairingStatus,
  loadPairingState,
  markPairingPending,
  PairingStateLoadError,
  savePairingState,
  updatePairingState
} from '../src/lib/dm-pairing.js';

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-pairing-')), 'dm-pairing.json');
}

describe('dm pairing state', () => {
  it('loads missing state as empty but fails closed on malformed state', () => {
    expect(loadPairingState(tempFile())).toEqual({ pending: {}, denied: {} });

    const file = tempFile();
    fs.writeFileSync(file, '{bad json');
    expect(() => loadPairingState(file)).toThrow(PairingStateLoadError);
    expect(fs.readFileSync(file, 'utf8')).toBe('{bad json');
  });

  it('saves pairing state atomically with owner-only permissions', () => {
    const file = tempFile();
    const state = {
      pending: {
        1234567890: {
          userId: '1234567890',
          name: 'Felix',
          channelId: 'chan1',
          firstMessage: 'hello',
          requestedAt: '2026-06-04T00:00:00.000Z'
        }
      },
      denied: {}
    };

    expect(savePairingState(state, file)).toBe(true);
    expect(loadPairingState(file)).toEqual(state);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('aborts locked mutations when pairing state is malformed without overwriting it', () => {
    const file = tempFile();
    fs.writeFileSync(file, '{bad json');

    expect(() => updatePairingState((state) => {
      state.pending['1234567890'] = { userId: '1234567890' };
      return true;
    }, file)).toThrow(PairingStateLoadError);

    expect(fs.readFileSync(file, 'utf8')).toBe('{bad json');
  });

  it('marks pending once, truncates first message, and does not requeue denied users', () => {
    const state = { pending: {}, denied: {} };
    const longMessage = 'x'.repeat(600);

    expect(markPairingPending({
      userId: '1234567890',
      name: 'Felix',
      channelId: 'chan1',
      firstMessage: longMessage
    }, state)).toBe(true);
    expect(markPairingPending({
      userId: '1234567890',
      name: 'Felix 2',
      channelId: 'chan2',
      firstMessage: 'again'
    }, state)).toBe(false);
    expect(Object.keys(state.pending)).toEqual(['1234567890']);
    expect(state.pending['1234567890'].firstMessage).toHaveLength(500);
    expect(getPairingStatus(state, '1234567890')).toBe('pending');

    denyPairingUser({ dmAllowFrom: [] }, '1234567890', 'no', state);
    expect(markPairingPending({
      userId: '1234567890',
      name: 'Felix',
      channelId: 'chan1',
      firstMessage: 'retry'
    }, state)).toBe(false);
    expect(state.pending).toEqual({});
    expect(getPairingStatus(state, '1234567890')).toBe('denied');
  });

  it('approves users by adding dmAllowFrom and clearing pending plus denied state', () => {
    const config = { dmAllowFrom: ['1111111111'] };
    const state = {
      pending: { 1234567890: { userId: '1234567890' } },
      denied: { 1234567890: { userId: '1234567890' } }
    };

    expect(approvePairingUser(config, '1234567890', state)).toBe(true);
    expect(approvePairingUser(config, '1234567890', state)).toBe(true);
    expect(config.dmAllowFrom).toEqual(['1111111111', '1234567890']);
    expect(state.pending).toEqual({});
    expect(state.denied).toEqual({});
    expect(getPairingStatus(state, '1234567890', config)).toBe('approved');
  });

  it('denies users by recording denial, clearing pending, and removing allowlist access', () => {
    const config = { dmAllowFrom: ['1234567890', '1111111111'] };
    const state = {
      pending: { 1234567890: { userId: '1234567890' } },
      denied: {}
    };

    expect(denyPairingUser(config, '1234567890', 'not now', state)).toBe(true);
    expect(config.dmAllowFrom).toEqual(['1111111111']);
    expect(state.pending).toEqual({});
    expect(state.denied['1234567890']).toMatchObject({
      userId: '1234567890',
      reason: 'not now'
    });
  });
});
