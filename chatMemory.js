const sessions = new Map();
const MAX_TURNS = Number(process.env.CHAT_MEMORY_TURNS) || 8;
const SESSION_TTL_MS = Number(process.env.CHAT_SESSION_TTL_MS) || 60 * 60 * 1000;

function pruneExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

export function getOrCreateSession(sessionId) {
  pruneExpired();
  const id = sessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  if (!sessions.has(id)) {
    sessions.set(id, { id, messages: [], updatedAt: Date.now() });
  }

  const session = sessions.get(id);
  session.updatedAt = Date.now();
  return session;
}

export function getHistoryForPrompt(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return [];

  return session.messages.slice(-MAX_TURNS * 2);
}

export function appendToSession(sessionId, role, content) {
  const session = getOrCreateSession(sessionId);
  session.messages.push({ role, content, at: new Date().toISOString() });
  if (session.messages.length > MAX_TURNS * 2) {
    session.messages = session.messages.slice(-MAX_TURNS * 2);
  }
  session.updatedAt = Date.now();
  return session;
}

export function clearSession(sessionId) {
  sessions.delete(sessionId);
}
