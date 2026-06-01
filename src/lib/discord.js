const API = 'https://discord.com/api/v10';
const MESSAGE_CONTENT_HINT = 'DISALLOWED INTENTS - enable "Message Content Intent" in the Developer Portal';

function formatUserTag(user) {
  if (user?.discriminator && user.discriminator !== '0') {
    return `${user.username}#${user.discriminator}`;
  }
  return user?.username || '';
}

export async function validateToken(token, { timeoutMs = 10_000 } = {}) {
  if (!token) {
    return { ok: false, error: 'DISCORD_BOT_TOKEN is not set' };
  }

  try {
    const res = await fetch(`${API}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (res.status === 401) {
      return { ok: false, error: 'Invalid bot token (401)' };
    }
    if (!res.ok) {
      return { ok: false, error: `Discord API ${res.status}` };
    }

    let user;
    try {
      user = await res.json();
    } catch {
      return { ok: false, error: 'Discord API returned invalid JSON' };
    }

    if (!user?.id || !user?.username) {
      return { ok: false, error: 'Discord API returned an invalid bot user' };
    }

    return {
      ok: true,
      id: String(user.id),
      username: user.username,
      tag: formatUserTag(user)
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err)
    };
  }
}

export function isSelfOrBotMessage(message, clientUserId) {
  if (!message?.author) return true;
  if (message.author.bot) return true;
  return String(message.author.id) === String(clientUserId);
}

export function normalizeGatewayError(err) {
  const code = err?.code ?? err?.status ?? err?.rawError?.code;
  const message = String(err?.message || err?.reason || err || 'Unknown gateway error');

  if (Number(code) === 4014 || /disallowed intents|privileged intent|message content intent|4014/i.test(message)) {
    return {
      message: MESSAGE_CONTENT_HINT,
      disallowedIntents: true
    };
  }

  return {
    message,
    disallowedIntents: false
  };
}
