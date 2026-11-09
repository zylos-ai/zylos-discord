import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sessionGroupFromEndpoint, isValidSessionGroup } from '../src/lib/session-group.js';
import {
  buildC4ReceiveArgs,
  buildEndpoint,
  buildEventEndpoint,
  classifyC4Rejection,
  sendToC4,
  GENERIC_REJECT_REPLY,
  UNCERTAIN_REPLY
} from '../src/lib/c4.js';

const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

describe('sessionGroupFromEndpoint', () => {
  const cases = [
    ['DM channel', buildEndpoint('1234567890123456789', { messageId: '42', correlationId: 'c1', dm: true }), 'dm-1234567890123456789'],
    ['DM event endpoint', buildEventEndpoint('1234567890123456789', { messageId: '9', kind: 'edit', dm: true, nonce: 'n', now: 1 }), 'dm-1234567890123456789'],
    ['guild channel', '987654321098765432|msg:1|req:x', 'channel-987654321098765432'],
    ['thread (own channel id)', '1122334455667788990|msg:7|req:y', 'channel-1122334455667788990'],
    ['event endpoint', buildEventEndpoint('555', { messageId: '9', kind: 'reaction', nonce: 'n', now: 1 }), 'channel-555'],
    ['channel id only', '777', 'channel-777'],
    ['admin notice', 'admin|type:dm-pairing', 'admin']
  ];
  for (const [name, endpoint, group] of cases) {
    it(`${name} -> ${group}`, () => {
      const got = sessionGroupFromEndpoint(endpoint);
      expect(got).toBe(group);
      expect(got.length).toBeLessThanOrEqual(95);
      expect(got).toMatch(GROUP_NAME);
      expect(isValidSessionGroup(got)).toBe(true);
    });
  }

  it('isValidSessionGroup follows the Core contract', () => {
    expect(isValidSessionGroup('a'.repeat(95))).toBe(true);
    expect(isValidSessionGroup('a'.repeat(96))).toBe(false);
    for (const bad of ['', '-x', '_x', 'a b', 'a/b', null, undefined]) expect(isValidSessionGroup(bad)).toBe(false);
  });

  it('ignores per-message parts', () => {
    expect(sessionGroupFromEndpoint('555|msg:1|req:a')).toBe(sessionGroupFromEndpoint('555|msg:2|req:b'));
  });

  it('dm marker is the only DM signal', () => {
    expect(sessionGroupFromEndpoint('555|msg:1|req:a|dm:1')).toBe('dm-555');
    expect(sessionGroupFromEndpoint('555|msg:1|req:a')).toBe('channel-555');
  });

  it('rejects a malformed dm marker', () => {
    expect(() => sessionGroupFromEndpoint('555|msg:1|dm:yes')).toThrow(/invalid dm marker/);
  });

  for (const bad of ['', '|msg:1', 'abc|msg:1', '0123|msg:1', '-55|msg:1', '1'.repeat(26), null, undefined]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => sessionGroupFromEndpoint(bad)).toThrow(/invalid Discord endpoint/);
    });
  }
});

describe('scripts/session-group.js', () => {
  const script = path.resolve('scripts/session-group.js');
  it('prints the same name as inbound', () => {
    const out = execFileSync(process.execPath, [script, '555|msg:1|req:a'], { encoding: 'utf8' });
    expect(out).toBe('channel-555\n');
  });
  it('exits 1 with stderr only on invalid input', () => {
    let err;
    try {
      execFileSync(process.execPath, [script, 'nope'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) { err = e; }
    expect(err.status).toBe(1);
    expect(err.stdout).toBe('');
    expect(err.stderr).toMatch(/invalid Discord endpoint/);
  });
});

describe('c4-receive option gating', () => {
  let dir;
  let oldZylosDir;
  const scriptsDir = () => path.join(dir, '.claude/skills/comm-bridge/scripts');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-c4-'));
    fs.mkdirSync(scriptsDir(), { recursive: true });
    oldZylosDir = process.env.ZYLOS_DIR;
    process.env.ZYLOS_DIR = dir;
  });
  afterEach(() => {
    if (oldZylosDir === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = oldZylosDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = ['--channel', 'discord', '--endpoint', '555|msg:1', '--json', '--content', 'hi'];
  const args = () => buildC4ReceiveArgs({ channel: 'discord', endpoint: '555|msg:1', content: 'hi', sessionGroup: 'channel-555' });

  it('old Core without manifest: args unchanged', () => {
    expect(args()).toEqual(base);
  });
  it('manifest without --session-group: args unchanged', () => {
    fs.writeFileSync(path.join(scriptsDir(), 'c4-receive-options.json'), JSON.stringify({ options: { '--json': {} } }));
    expect(args()).toEqual(base);
  });
  it('unreadable manifest: args unchanged', () => {
    fs.writeFileSync(path.join(scriptsDir(), 'c4-receive-options.json'), '{not json');
    expect(args()).toEqual(base);
  });
  it('manifest with --session-group: group passed without namespace', () => {
    fs.writeFileSync(path.join(scriptsDir(), 'c4-receive-options.json'), JSON.stringify({ options: { '--session-group': {} } }));
    expect(args()).toEqual([...base, '--session-group', 'channel-555']);
  });
});

describe('sendToC4 rejection handling', () => {
  const fail = (persisted) => ({
    error: Object.assign(new Error('exit 1'), { code: 1 }),
    stdout: JSON.stringify({ ok: false, error: { code: 'X', message: 'agent-facing detail', ...(persisted === undefined ? {} : { persisted }) } })
  });
  const run = (results, endpoint = '555|msg:1') => new Promise((resolve) => {
    const calls = [];
    const notices = [];
    const exec = (_bin, argv, _opts, cb) => {
      calls.push(argv);
      const r = results[calls.length - 1] || { error: null, stdout: '{"ok":true}' };
      cb(r.error, r.stdout);
    };
    sendToC4('discord', endpoint, 'hello', (n) => notices.push(n), {
      exec, retryDelayMs: 0, onDone: (outcome) => resolve({ outcome, calls, notices })
    });
  });

  it('classifies persisted', () => {
    expect(classifyC4Rejection({ error: { persisted: ['1'] } })).toBe('committed');
    expect(classifyC4Rejection({ error: { persisted: [] } })).toBe('not_stored');
    expect(classifyC4Rejection({ error: {} })).toBe('uncertain');
  });
  it('success sends once', async () => {
    const r = await run([{ error: null, stdout: '{"ok":true}' }]);
    expect(r.outcome).toBe('sent');
    expect(r.calls).toHaveLength(1);
    expect(r.notices).toEqual([]);
  });
  it('committed: no notice, no resend', async () => {
    const r = await run([fail(['row-1'])]);
    expect(r.outcome).toBe('committed');
    expect(r.calls).toHaveLength(1);
    expect(r.notices).toEqual([null]);
  });
  it('not stored: generic notice, core text never shown', async () => {
    const r = await run([fail([])]);
    expect(r.notices).toEqual([GENERIC_REJECT_REPLY]);
    expect(r.calls).toHaveLength(1);
  });
  it('unknown persistence: uncertain notice', async () => {
    const r = await run([fail(undefined)]);
    expect(r.notices).toEqual([UNCERTAIN_REPLY]);
  });
  it('crash then success: retried with identical args', async () => {
    const r = await run([{ error: new Error('crash'), stdout: '' }, { error: null, stdout: '{"ok":true}' }]);
    expect(r.outcome).toBe('sent');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toEqual(r.calls[0]);
  });
  it('invalid endpoint: never sent to the overall group', async () => {
    const r = await run([], 'not-a-channel');
    expect(r.outcome).toBe('rejected');
    expect(r.calls).toHaveLength(0);
    expect(r.notices).toEqual([GENERIC_REJECT_REPLY]);
  });
});
