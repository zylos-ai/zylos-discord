import {
  getPairingStatus,
  markPairingPending
} from './dm-pairing.js';

export const PAIRING_REQUEST_REPLY = 'Thanks - your request to chat has been sent to the owner for approval.';

function cloneState(state) {
  return JSON.parse(JSON.stringify({
    pending: state?.pending || {},
    denied: state?.denied || {}
  }));
}

function restoreState(state, snapshot) {
  state.pending = snapshot.pending || {};
  state.denied = snapshot.denied || {};
}

export async function handleUnauthorizedPairingDm({
  config,
  userId,
  name,
  channelId,
  firstMessage,
  loadPairingState,
  savePairingState,
  notifyOwner,
  reply
}) {
  if ((config?.dmPolicy || 'owner') !== 'pairing') {
    return { handled: false };
  }

  const state = loadPairingState();
  const status = getPairingStatus(state, userId, config);
  if (status === 'pending' || status === 'denied') {
    return { handled: true, silent: true, status };
  }
  if (status === 'approved') {
    return { handled: false, status };
  }

  const snapshot = cloneState(state);
  markPairingPending({ userId, name, channelId, firstMessage }, state);
  if (!savePairingState(state)) {
    restoreState(state, snapshot);
    await reply?.('Internal error, please try again.');
    return { handled: true, error: 'save_failed' };
  }

  await notifyOwner?.({
    userId: String(userId),
    name,
    channelId,
    firstMessage
  });
  await reply?.(PAIRING_REQUEST_REPLY);
  return { handled: true, queued: true, status: 'new' };
}
