import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import {
  sessionGroupFromEndpoint,
  isValidSessionGroup,
  resolveSessionGroup,
  UnknownConversationError
} from '../src/lib/session-group.js';
import {
  channelKindsPath,
  getChannelKind,
  recordChannelFromMessage,
  recordChannelKind,
  resetChannelKindsCache
} from '../src/lib/channel-kinds.js';
import { eventEndpoint, rememberMessageMetadata, resolveMessageForDelete, clearMessageMetadataCache } from '../src/lib/inbound.js';
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

// Every test runs against a temp HOME whose channel-kinds.json holds the
// kinds the component would have recorded on inbound.
const SEEDED = {
  '1234567890123456789': { kind: 'dm', userId: '42' },
  '987654321098765432': { kind: 'guild', policyChannelId: '987654321098765432' },
  '1122334455667788990': { kind: 'guild', policyChannelId: '987654321098765432' },
  '555': { kind: 'guild', policyChannelId: '555' },
  '777': { kind: 'guild', policyChannelId: '777' }
};
let originalHome;
let home;
beforeEach(() => {
  originalHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-sg-'));
  process.env.HOME = home;
  fs.mkdirSync(path.dirname(channelKindsPath()), { recursive: true });
  fs.writeFileSync(channelKindsPath(), JSON.stringify(SEEDED));
  resetChannelKindsCache();
});
afterEach(() => {
  process.env.HOME = originalHome;
  resetChannelKindsCache();
  fs.rmSync(home, { recursive: true, force: true });
});

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

  it('the dm marker never decides: the recorded kind does', () => {
    // dm:1 on a guild channel (agent-written or a mis-marked event) stays a channel
    expect(sessionGroupFromEndpoint('555|msg:1|req:a|dm:1')).toBe('channel-555');
    // a DM endpoint without the marker (pre-upgrade scheduler task) is still the DM thread
    expect(sessionGroupFromEndpoint('1234567890123456789')).toBe('dm-1234567890123456789');
    expect(sessionGroupFromEndpoint('1234567890123456789|req:old-task')).toBe('dm-1234567890123456789');
  });

  it('an unseen channel is an unknown conversation, never guessed', () => {
    expect(() => sessionGroupFromEndpoint('31415926535|msg:1')).toThrow(UnknownConversationError);
    expect(() => sessionGroupFromEndpoint('31415926535|dm:1')).toThrow(/unknown Discord conversation/);
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
  const runScript = (arg, env = {}) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [script, arg], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, HOME: home, ...env } }), stderr: '' };
    } catch (e) {
      return { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  };
  it('prints the same name as inbound', () => {
    expect(runScript('555|msg:1|req:a')).toMatchObject({ status: 0, stdout: 'channel-555\n' });
    expect(runScript('1234567890123456789|req:old')).toMatchObject({ status: 0, stdout: 'dm-1234567890123456789\n' });
  });
  it('unseen channel and no API answer: exit 1, nothing on stdout', () => {
    const r = runScript('31415926535|msg:1', { DISCORD_API_BASE: 'http://127.0.0.1:9', DISCORD_BOT_TOKEN: 'x' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/unknown Discord conversation/);
  });
  it('unseen channel: asks the Discord API once and records the answer', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: '31415926535', type: 1, recipients: [{ id: 'u1' }] }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address();
      const out = await new Promise((resolve) => {
        const p = spawn(process.execPath, [script, '31415926535|req:x'], {
          env: { ...process.env, HOME: home, DISCORD_API_BASE: `http://127.0.0.1:${port}`, DISCORD_BOT_TOKEN: 'x' }
        });
        let stdout = '';
        p.stdout.on('data', (c) => { stdout += c; });
        p.on('close', (code) => resolve({ code, stdout }));
      });
      expect(out).toEqual({ code: 0, stdout: 'dm-31415926535\n' });
      resetChannelKindsCache();
      expect(getChannelKind('31415926535')).toEqual({ kind: 'dm', userId: 'u1' });
      // now known: the in-process mapping (inbound) agrees
      expect(sessionGroupFromEndpoint('31415926535|msg:2')).toBe('dm-31415926535');
    } finally {
      server.close();
    }
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

let sgCoreDir = null;
let sgOldZylosDir;
/** Point ZYLOS_DIR at a fake Core whose c4-receive accepts --session-group. */
function withSessionGroupCore() {
  sgCoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-core-'));
  const dir = path.join(sgCoreDir, '.claude/skills/comm-bridge/scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c4-receive-options.json'), JSON.stringify({ options: { '--session-group': {} } }));
  sgOldZylosDir = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = sgCoreDir;
}
afterEach(() => {
  if (!sgCoreDir) return;
  if (sgOldZylosDir === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = sgOldZylosDir;
  fs.rmSync(sgCoreDir, { recursive: true, force: true });
  sgCoreDir = null;
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
    const r = await run([fail([]), fail([])]);
    expect(r.notices).toEqual([GENERIC_REJECT_REPLY]);
    // code X is not transient, so no retry
    expect(r.calls).toHaveLength(1);
  });
  it('unknown persistence: uncertain notice', async () => {
    const r = await run([fail(undefined)]);
    expect(r.notices).toEqual([UNCERTAIN_REPLY]);
  });
  it('crash: not retried (it may have stored the row)', async () => {
    const r = await run([{ error: new Error('crash'), stdout: '' }, { error: null, stdout: '{"ok":true}' }]);
    expect(r.outcome).toBe('uncertain');
    expect(r.calls).toHaveLength(1);
  });
  it('invalid endpoint: never sent to the overall group', async () => {
    withSessionGroupCore();
    const r = await run([], 'not-a-channel');
    expect(r.outcome).toBe('rejected');
    expect(r.calls).toHaveLength(0);
    expect(r.notices).toEqual([GENERIC_REJECT_REPLY]);
  });
  it('old Core without --session-group: group is not derived, message still sent', async () => {
    const r = await run([], 'not-a-channel');
    expect(r.outcome).toBe('sent');
    expect(r.calls[0]).not.toContain('--session-group');
  });
});

describe('channel-kinds write failure (review PR #25 approval)', () => {
  const deliver = (endpoint) => new Promise((resolve) => {
    const calls = [];
    const notices = [];
    sendToC4('discord', endpoint, 'hello', (n) => notices.push(n), {
      exec: (_bin, argv, _opts, cb) => { calls.push(argv); cb(null, '{"ok":true}'); },
      retryDelayMs: 0,
      onDone: (outcome) => resolve({ outcome, calls, notices })
    });
  });
  const breakStore = () => {
    fs.rmSync(channelKindsPath(), { force: true });
    fs.mkdirSync(channelKindsPath());
    resetChannelKindsCache();
  };
  const dm = { author: { id: 'u7', bot: false }, channel: { id: '4242424242', isDMBased: () => true } };

  it('channel-kinds.json replaced by a directory: inbound DM still delivered to its DM group', async () => {
    withSessionGroupCore();
    breakStore();
    expect(recordChannelFromMessage(dm)).toBe(false);
    expect(getChannelKind('4242424242')).toEqual({ kind: 'dm', userId: 'u7' });
    const r = await deliver(buildEndpoint('4242424242', { messageId: '1', correlationId: 'c' }));
    expect(r.outcome).toBe('sent');
    expect(r.notices).toEqual([]);
    expect(r.calls[0].slice(-2)).toEqual(['--session-group', 'dm-4242424242']);
    expect(fs.readdirSync(path.dirname(channelKindsPath())).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('observed kind survives a fresh reload of the (unreadable) file', () => {
    breakStore();
    recordChannelFromMessage(dm);
    // A miss on another id forces load({ fresh: true }), which replaces the cache.
    expect(getChannelKind('999999')).toBeNull();
    expect(getChannelKind('4242424242')).toEqual({ kind: 'dm', userId: 'u7' });
  });
  it('old Core: a broken store never blocks inbound', async () => {
    breakStore();
    const r = await deliver('77777777|msg:1');
    expect(r.outcome).toBe('sent');
  });
});

describe('channel kinds come from what the component observed (review PR #25)', () => {
  it('a guild delete event rebuilt from cached metadata is not marked dm and maps to the channel', async () => {
    clearMessageMetadataCache();
    rememberMessageMetadata({
      id: 'm1',
      content: 'hi',
      author: { id: 'u1', username: 'u', bot: false },
      channel: { id: '987654321098765432', name: 'general', isDMBased: () => false, isThread: () => false },
      inGuild: () => true
    });
    // Uncached deleted message: discord.js gives a partial without channel data we can use.
    const standIn = await resolveMessageForDelete(
      { id: 'm1', channelId: '987654321098765432', partial: true, channel: { id: '987654321098765432' } },
      { fetchPartial: async () => null }
    );
    expect(standIn.guild).toBeUndefined();
    const endpoint = eventEndpoint(standIn, 'delete', { nonce: 'n', now: 1 });
    expect(endpoint).not.toContain('dm:1');
    fs.writeFileSync(channelKindsPath(), '{}');
    resetChannelKindsCache();
    recordChannelFromMessage(standIn);
    expect(sessionGroupFromEndpoint(endpoint)).toBe('channel-987654321098765432');
  });

  it('a DM event endpoint carries dm:1 and maps to the DM thread', () => {
    const msg = { id: 'm2', author: { id: 'bot', bot: true }, channel: { id: '1234567890123456789', isDMBased: () => true } };
    const endpoint = eventEndpoint(msg, 'reaction', { nonce: 'n', now: 1 });
    expect(endpoint).toContain('dm:1');
    expect(sessionGroupFromEndpoint(endpoint)).toBe('dm-1234567890123456789');
  });

  it('recordChannelFromMessage stores DM recipient and thread parent', () => {
    fs.writeFileSync(channelKindsPath(), '{}');
    resetChannelKindsCache();
    recordChannelFromMessage({ author: { id: 'u9', bot: false }, channel: { id: '11', isDMBased: () => true } });
    recordChannelFromMessage({ author: { id: 'u9' }, channel: { id: '12', isDMBased: () => false, isThread: () => true, parentId: '10' } });
    expect(getChannelKind('11')).toEqual({ kind: 'dm', userId: 'u9' });
    expect(getChannelKind('12')).toEqual({ kind: 'guild', policyChannelId: '10' });
  });

  it('the first recorded kind wins, so a mapping never moves', () => {
    expect(recordChannelKind('555', 'dm', { userId: 'x' })).toBe(false);
    expect(sessionGroupFromEndpoint('555')).toBe('channel-555');
    resetChannelKindsCache();
    expect(getChannelKind('555').kind).toBe('guild');
  });

  it('a record written by another process is picked up without restart', () => {
    expect(getChannelKind('2718281828')).toBeNull();
    const data = JSON.parse(fs.readFileSync(channelKindsPath(), 'utf8'));
    data['2718281828'] = { kind: 'guild' };
    fs.writeFileSync(channelKindsPath(), JSON.stringify(data));
    expect(sessionGroupFromEndpoint('2718281828')).toBe('channel-2718281828');
  });

  it('resolveSessionGroup: API type decides, failures are unknown', async () => {
    await expect(resolveSessionGroup('31', { lookup: async () => ({ id: '31', type: 0 }) })).resolves.toBe('channel-31');
    await expect(resolveSessionGroup('32', { lookup: async () => ({ id: '32', type: 11, parent_id: '31' }) })).resolves.toBe('channel-32');
    expect(getChannelKind('32')).toEqual({ kind: 'guild', policyChannelId: '31' });
    await expect(resolveSessionGroup('33', { lookup: async () => ({ id: '33', type: 1, recipients: [{ id: 'u' }] }) })).resolves.toBe('dm-33');
    await expect(resolveSessionGroup('34', { lookup: async () => { throw new Error('Discord API 404'); } })).rejects.toThrow(UnknownConversationError);
    await expect(resolveSessionGroup('35', { lookup: async () => ({ id: '35', type: 3 }) })).rejects.toThrow(/group DM/);
    await expect(resolveSessionGroup('36', { lookup: async () => ({ id: '999', type: 0 }) })).rejects.toThrow(UnknownConversationError);
    // a known channel never hits the API
    await expect(resolveSessionGroup('555', { lookup: async () => { throw new Error('should not be called'); } })).resolves.toBe('channel-555');
  });
});

describe('sendToC4 retry policy (zylos-telegram v0.6.0)', () => {
  const run = (results) => new Promise((resolve) => {
    const calls = [];
    const notices = [];
    const exec = (_bin, argv, _opts, cb) => {
      calls.push(argv);
      const r = results[calls.length - 1] || { error: null, stdout: '{"ok":true}' };
      cb(r.error, r.stdout);
    };
    sendToC4('discord', '555|msg:1', 'hello', (n) => notices.push(n), {
      exec, retryDelayMs: 0, onDone: (outcome) => resolve({ outcome, calls, notices })
    });
  });
  const notStored = { error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: JSON.stringify({ ok: false, error: { code: 'DB_BUSY', message: 'x', persisted: [] } }) };
  const spawnFail = { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', syscall: 'spawn node' }), stdout: '' };

  it('ok:false with persisted=[] is retried once, then succeeds', async () => {
    const r = await run([notStored, { error: null, stdout: '{"ok":true}' }]);
    expect(r.outcome).toBe('sent');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toEqual(r.calls[0]);
    expect(r.notices).toEqual([]);
  });
  it('ok:false with persisted=[] twice: generic notice, no third try', async () => {
    const r = await run([notStored, notStored]);
    expect(r.calls).toHaveLength(2);
    expect(r.notices).toEqual([GENERIC_REJECT_REPLY]);
  });
  it('ok:false persisted=[] with a deterministic code (INVALID_ARGS): not retried', async () => {
    const invalid = { error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: JSON.stringify({ ok: false, error: { code: 'INVALID_ARGS', message: 'x', persisted: [] } }) };
    const r = await run([invalid, { error: null, stdout: '{"ok":true}' }]);
    expect(r.outcome).toBe('rejected');
    expect(r.calls).toHaveLength(1);
    expect(r.notices).toEqual([GENERIC_REJECT_REPLY]);
  });
  it('c4-receive never started: retried once', async () => {
    const r = await run([spawnFail, { error: null, stdout: '{"ok":true}' }]);
    expect(r.outcome).toBe('sent');
    expect(r.calls).toHaveLength(2);
  });
  it('ran without a structured answer (crash/kill): not retried, uncertain notice', async () => {
    const r = await run([{ error: new Error('killed'), stdout: '' }, { error: null, stdout: '{"ok":true}' }]);
    expect(r.outcome).toBe('uncertain');
    expect(r.calls).toHaveLength(1);
    expect(r.notices).toEqual([UNCERTAIN_REPLY]);
  });
  it('ok:true printed, then killed: counted as sent, no notice', async () => {
    const r = await run([{ error: Object.assign(new Error('killed'), { signal: 'SIGKILL' }), stdout: '{"ok":true,"id":62}' }]);
    expect(r.outcome).toBe('sent');
    expect(r.calls).toHaveLength(1);
    expect(r.notices).toEqual([]);
  });
  it('ok:false without persisted: not retried', async () => {
    const r = await run([{ error: new Error('exit 1'), stdout: JSON.stringify({ ok: false, error: { code: 'X', message: 'm' } }) }]);
    expect(r.calls).toHaveLength(1);
    expect(r.notices).toEqual([UNCERTAIN_REPLY]);
  });
});
