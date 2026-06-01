import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSelfOrBotMessage, normalizeGatewayError, validateToken } from '../src/lib/discord.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isSelfOrBotMessage', () => {
  it('drops malformed messages', () => {
    expect(isSelfOrBotMessage(null, '123')).toBe(true);
    expect(isSelfOrBotMessage({}, '123')).toBe(true);
  });

  it('drops messages from bots', () => {
    expect(isSelfOrBotMessage({ author: { id: '456', bot: true } }, '123')).toBe(true);
  });

  it('drops messages from the client user', () => {
    expect(isSelfOrBotMessage({ author: { id: '123', bot: false } }, 123)).toBe(true);
  });

  it('allows normal user messages', () => {
    expect(isSelfOrBotMessage({ author: { id: '456', bot: false } }, '123')).toBe(false);
  });
});

describe('validateToken', () => {
  it('rejects missing tokens without fetching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(validateToken('')).resolves.toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns bot identity for valid tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ id: '42', username: 'zylos', discriminator: '1234' })
    }));

    await expect(validateToken('token')).resolves.toEqual({
      ok: true,
      id: '42',
      username: 'zylos',
      tag: 'zylos#1234'
    });
  });

  it('handles new Discord usernames without discriminator suffix', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ id: '42', username: 'zylos', discriminator: '0' })
    }));

    await expect(validateToken('token')).resolves.toMatchObject({ ok: true, tag: 'zylos' });
  });

  it('maps unauthorized and non-2xx responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(validateToken('token')).resolves.toEqual({ ok: false, error: 'Invalid bot token (401)' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(validateToken('token')).resolves.toEqual({ ok: false, error: 'Discord API 500' });
  });

  it('rejects invalid JSON and malformed identity bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error('bad json'))
    }));
    await expect(validateToken('token')).resolves.toEqual({ ok: false, error: 'Discord API returned invalid JSON' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ id: '42' })
    }));
    await expect(validateToken('token')).resolves.toEqual({ ok: false, error: 'Discord API returned an invalid bot user' });
  });

  it('maps timeout errors', async () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));

    await expect(validateToken('token')).resolves.toEqual({ ok: false, error: 'timeout' });
  });
});

describe('normalizeGatewayError', () => {
  it('maps disallowed intent failures to an actionable message', () => {
    expect(normalizeGatewayError({ code: 4014 })).toEqual({
      message: 'DISALLOWED INTENTS - enable "Message Content Intent" in the Developer Portal',
      disallowedIntents: true
    });
    expect(normalizeGatewayError(new Error('Used disallowed intents'))).toMatchObject({
      disallowedIntents: true
    });
  });

  it('preserves ordinary gateway errors', () => {
    expect(normalizeGatewayError(new Error('network down'))).toEqual({
      message: 'network down',
      disallowedIntents: false
    });
  });
});
