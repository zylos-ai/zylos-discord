import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-media-'));
}

async function importMedia(home) {
  vi.resetModules();
  process.env.HOME = home;
  return import('../src/lib/media.js');
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('media helpers', () => {
  it('sanitizes filenames and identifies image attachments', async () => {
    const media = await importMedia(makeHome());

    expect(media.safeFileName('../../etc/passwd')).toBe('passwd');
    expect(media.safeFileName('a b<>.png')).toBe('a_b__.png');
    expect(media.isImage({ contentType: 'image/png' })).toBe(true);
    expect(media.isImage({ contentType: 'application/pdf' })).toBe(false);
  });

  it('rejects non-HTTPS attachment URLs', async () => {
    const media = await importMedia(makeHome());

    await expect(media.downloadAttachment({
      url: 'http://cdn.example/file.png',
      name: 'file.png',
      size: 1
    })).resolves.toMatchObject({ skipped: true, reason: 'invalid_url' });
  });

  it('skips attachments over declared and streamed size caps', async () => {
    const media = await importMedia(makeHome());

    await expect(media.downloadAttachment({
      url: 'https://cdn.example/big.bin',
      name: 'big.bin',
      size: 20
    }, { maxBytes: 10 })).resolves.toMatchObject({ skipped: true, reason: 'too_large' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('too-large-body', {
      headers: { 'content-length': '4' }
    })));

    await expect(media.downloadAttachment({
      url: 'https://cdn.example/body.bin',
      name: 'body.bin',
      size: 4
    }, { maxBytes: 4 })).resolves.toMatchObject({ skipped: true, reason: 'too_large' });
  });

  it('writes downloaded media privately inside the media directory', async () => {
    const home = makeHome();
    const media = await importMedia(home);
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('hello', {
      headers: { 'content-length': '5' }
    })));

    const result = await media.downloadAttachment({
      url: 'https://cdn.example/path/../../hello world.txt',
      name: '../../hello world.txt',
      size: 5,
      contentType: 'text/plain'
    });

    const mediaDir = path.join(home, 'zylos/components/discord/media');
    expect(result).toMatchObject({
      filePath: path.join(mediaDir, '12345-hello_world.txt'),
      name: '../../hello world.txt',
      contentType: 'text/plain',
      size: 5
    });
    expect((fs.statSync(mediaDir).mode & 0o777).toString(8)).toBe('700');
    expect((fs.statSync(result.filePath).mode & 0o777).toString(8)).toBe('600');
    expect(fs.readFileSync(result.filePath, 'utf8')).toBe('hello');
  });
});
