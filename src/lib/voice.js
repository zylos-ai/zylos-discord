import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const TRANSCRIBE_SCRIPT = path.join(process.env.HOME || '', 'zylos/bin/transcribe');
export const VOICE_UNAVAILABLE_NOTE = '[voice message - transcription unavailable]';
export const VOICE_DISABLED_NOTE = '[voice message - transcription disabled]';
export const MESSAGE_FLAG_IS_VOICE_MESSAGE = 1 << 13;

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasFlag(flags, bit, name) {
  if (!flags) return false;
  if (typeof flags.has === 'function') {
    try {
      if (flags.has(name) || flags.has(bit)) return true;
    } catch {}
  }
  const value = typeof flags.bitfield === 'number' ? flags.bitfield : Number(flags);
  return Number.isFinite(value) && (value & bit) === bit;
}

function voiceMode(config) {
  if (config?.voiceTranscription === false) return 'disabled';
  if (config?.voiceTranscription === true) return 'auto';
  const mode = String(config?.voiceTranscription || 'auto').trim().toLowerCase();
  return ['auto', 'local', 'disabled'].includes(mode) ? mode : 'auto';
}

export function isVoiceMessageAttachment(attachment, message = null) {
  if (!attachment) return false;
  const contentType = String(attachment.contentType || '').toLowerCase();
  if (!contentType.startsWith('audio/')) return false;

  if (hasFlag(message?.flags, MESSAGE_FLAG_IS_VOICE_MESSAGE, 'IsVoiceMessage')) return true;

  const hasDuration = Number.isFinite(Number(attachment.duration)) && Number(attachment.duration) > 0;
  const hasWaveform = typeof attachment.waveform === 'string' && attachment.waveform.length > 0;
  return hasDuration && hasWaveform;
}

export function voiceTranscriptionEnabled(config, { transcribePath = TRANSCRIBE_SCRIPT } = {}) {
  const mode = voiceMode(config);
  if (mode === 'disabled') return false;
  if (mode === 'local' || mode === 'auto') return isExecutable(transcribePath);
  return false;
}

export function transcribeAudio(audioPath, { transcribePath = TRANSCRIBE_SCRIPT, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(transcribePath, [audioPath], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

export async function resolveVoiceNote(attachment, filePath, config, options = {}) {
  const mode = voiceMode(config);
  if (mode === 'disabled') {
    return { voice: true, note: VOICE_DISABLED_NOTE };
  }
  if (!voiceTranscriptionEnabled(config, options)) {
    return { voice: true, note: VOICE_UNAVAILABLE_NOTE };
  }

  try {
    const transcript = await transcribeAudio(filePath, options);
    if (!transcript) {
      return { voice: true, note: VOICE_UNAVAILABLE_NOTE };
    }
    return { voice: true, note: `[Voice] ${transcript}` };
  } catch {
    return { voice: true, note: VOICE_UNAVAILABLE_NOTE };
  }
}
