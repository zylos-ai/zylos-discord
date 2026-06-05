import { describe, expect, it, vi } from 'vitest';
import { resolveInboundAttachments } from '../src/index.js';

function attachment(name) {
  return { name, id: name };
}

describe('inbound attachment resolver', () => {
  it('resolves multiple inbound attachments with per-file notes and paths', async () => {
    const attachments = [
      attachment('one.txt'),
      attachment('two.txt'),
      attachment('three.txt')
    ];
    const message = { id: 'msg1' };
    const resolveMedia = vi.fn(async (_config, oneAttachment, options) => ({
      filePath: `/tmp/${oneAttachment.name}`,
      note: `[sent a file: ${oneAttachment.name}]`,
      options
    }));

    const result = await resolveInboundAttachments({}, attachments, {
      download: true,
      message,
      resolveMedia
    });

    expect(result).toEqual({
      filePaths: ['/tmp/one.txt', '/tmp/two.txt', '/tmp/three.txt'],
      note: '[sent a file: one.txt] [sent a file: two.txt] [sent a file: three.txt]'
    });
    expect(resolveMedia).toHaveBeenCalledTimes(3);
    expect(resolveMedia).toHaveBeenNthCalledWith(1, {}, attachments[0], { download: true, message });
  });

  it('caps processing at ten attachments and reports overflow', async () => {
    const attachments = Array.from({ length: 12 }, (_value, index) => attachment(`file-${index + 1}.txt`));
    const resolveMedia = vi.fn(async (_config, oneAttachment) => ({
      filePath: `/tmp/${oneAttachment.name}`,
      note: `[sent a file: ${oneAttachment.name}]`
    }));

    const result = await resolveInboundAttachments({}, attachments, {
      download: true,
      resolveMedia
    });

    expect(resolveMedia).toHaveBeenCalledTimes(10);
    expect(result.filePaths).toHaveLength(10);
    expect(result.filePaths.at(-1)).toBe('/tmp/file-10.txt');
    expect(result.note).toContain('[sent a file: file-10.txt]');
    expect(result.note).toContain('[+2 more attachments not processed]');
    expect(result.note).not.toContain('file-11.txt');
  });

  it('emits disabled-download notes without resolving media paths', async () => {
    const attachments = [
      attachment('one.txt'),
      attachment('two.txt'),
      attachment('three.txt')
    ];
    const resolveMedia = vi.fn();

    const result = await resolveInboundAttachments({}, attachments, {
      disabledNote: true,
      resolveMedia
    });

    expect(result).toEqual({
      filePaths: [],
      note: '[attachment skipped: media downloads disabled: one.txt] [attachment skipped: media downloads disabled: two.txt] [attachment skipped: media downloads disabled: three.txt]'
    });
    expect(resolveMedia).not.toHaveBeenCalled();
  });
});
