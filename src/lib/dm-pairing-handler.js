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

async function failClosed(reply, err) {
  console.error(`[discord] failed to load DM pairing state: ${err.message}`);
  await reply?.('Internal error, please try again.');
  return { handled: true, error: 'state_load_failed' };
}

export async function handleUnauthorizedPairingDm({
  config,
  userId,
  name,
  channelId,
  firstMessage,
  loadPairingState,
  savePairingState,
  updatePairingState,
  notifyOwner,
  reply
}) {
  if ((config?.dmPolicy || 'owner') !== 'pairing') {
    return { handled: false };
  }

  if (updatePairingState) {
    let queued = null;
    try {
      const updated = updatePairingState((state) => {
        const status = getPairingStatus(state, userId, config);
        if (status === 'pending' || status === 'denied') {
          queued = { handled: true, silent: true, status };
          return false;
        }
        if (status === 'approved') {
          queued = { handled: false, status };
          return false;
        }
        markPairingPending({ userId, name, channelId, firstMessage }, state);
        queued = { handled: true, queued: true, status: 'new' };
        return true;
      });
      if (!updated.ok) {
        await reply?.('Internal error, please try again.');
        return { handled: true, error: 'save_failed' };
      }
    } catch (err) {
      return failClosed(reply, err);
    }

    if (!queued?.queued) return queued;
    await notifyOwner?.({
      userId: String(userId),
      name,
      channelId,
      firstMessage
    });
    await reply?.(PAIRING_REQUEST_REPLY);
    return queued;
  }

  let state;
  try {
    state = loadPairingState();
  } catch (err) {
    return failClosed(reply, err);
  }
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
