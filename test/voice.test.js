import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_FLAG_IS_VOICE_MESSAGE,
  VOICE_DISABLED_NOTE,
  VOICE_UNAVAILABLE_NOTE,
  isVoiceMessageAttachment,
  resolveVoiceNote,
  voiceTranscriptionEnabled
} from '../src/lib/voice.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-voice-'));
}

function makeExecutable(dir, name, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, { mode: 0o700 });
  fs.chmodSync(filePath, 0o700);
  return filePath;
}

describe('voice helpers', () => {
  it('detects Discord voice-note attachments from audio metadata', () => {
    expect(isVoiceMessageAttachment({
      contentType: 'audio/ogg',
      duration: 3.2,
      waveform: 'abc'
    })).toBe(true);

    expect(isVoiceMessageAttachment({
      contentType: 'audio/mpeg',
      duration: null,
      waveform: null
    })).toBe(false);

    expect(isVoiceMessageAttachment({
      contentType: 'image/png',
      duration: 3,
      waveform: 'abc'
    })).toBe(false);
  });

  it('detects voice-note audio from message flags when available', () => {
    expect(isVoiceMessageAttachment(
      { contentType: 'audio/ogg' },
      { flags: { bitfield: MESSAGE_FLAG_IS_VOICE_MESSAGE } }
    )).toBe(true);

    expect(isVoiceMessageAttachment(
      { contentType: 'audio/ogg' },
      { flags: { has: (flag) => flag === 'IsVoiceMessage' } }
    )).toBe(true);
  });

  it('uses the configured local transcribe tool when available', async () => {
    const dir = makeTempDir();
    const transcribePath = makeExecutable(dir, 'transcribe-ok', '#!/bin/sh\necho "hello voice"\n');
    const audioPath = path.join(dir, 'voice.ogg');
    fs.writeFileSync(audioPath, 'audio');

    expect(voiceTranscriptionEnabled({ voiceTranscription: 'auto' }, { transcribePath })).toBe(true);
    await expect(resolveVoiceNote({}, audioPath, { voiceTranscription: 'auto' }, { transcribePath }))
      .resolves.toEqual({ voice: true, note: '[Voice] hello voice' });
  });

  it('keeps graceful notes when tool is absent, disabled, failing, or empty', async () => {
    const dir = makeTempDir();
    const missingPath = path.join(dir, 'missing-transcribe');
    const failPath = makeExecutable(dir, 'transcribe-fail', '#!/bin/sh\necho "boom" >&2\nexit 1\n');
    const emptyPath = makeExecutable(dir, 'transcribe-empty', '#!/bin/sh\nexit 0\n');
    const audioPath = path.join(dir, 'voice.ogg');
    fs.writeFileSync(audioPath, 'audio');

    expect(voiceTranscriptionEnabled({ voiceTranscription: 'auto' }, { transcribePath: missingPath })).toBe(false);
    await expect(resolveVoiceNote({}, audioPath, { voiceTranscription: 'auto' }, { transcribePath: missingPath }))
      .resolves.toEqual({ voice: true, note: VOICE_UNAVAILABLE_NOTE });
    await expect(resolveVoiceNote({}, audioPath, { voiceTranscription: 'disabled' }, { transcribePath: failPath }))
      .resolves.toEqual({ voice: true, note: VOICE_DISABLED_NOTE });
    await expect(resolveVoiceNote({}, audioPath, { voiceTranscription: false }, { transcribePath: failPath }))
      .resolves.toEqual({ voice: true, note: VOICE_DISABLED_NOTE });
    await expect(resolveVoiceNote({}, audioPath, { voiceTranscription: 'auto' }, { transcribePath: failPath }))
      .resolves.toEqual({ voice: true, note: VOICE_UNAVAILABLE_NOTE });
    await expect(resolveVoiceNote({}, audioPath, { voiceTranscription: 'auto' }, { transcribePath: emptyPath }))
      .resolves.toEqual({ voice: true, note: VOICE_UNAVAILABLE_NOTE });
  });
});
