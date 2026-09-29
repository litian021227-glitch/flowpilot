import './styles.css';

const authUrl = import.meta.env.VITE_SUPABASE_URL || '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const storageKey = 'flowpilot.auth.session';
const nativeFetch = window.fetch.bind(window);

export const authConfigured = Boolean(authUrl && anonKey);

function readSession() {
  try { return JSON.parse(window.localStorage.getItem(storageKey) || 'null'); } catch { return null; }
}

export function getSession() {
  const session = readSession();
  if (session?.expires_at && session.expires_at * 1000 < Date.now()) { window.localStorage.removeItem(storageKey); return null; }
  return session;
}

async function authRequest(path, body) {
  const response = await nativeFetch(`${authUrl}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.msg || data.message || '认证请求失败');
  return data;
}

export async function signIn(email, password) {
  const session = await authRequest('token?grant_type=password', { email, password });
  window.localStorage.setItem(storageKey, JSON.stringify(session));
  return session;
}

export async function signUp(email, password) {
  const data = await authRequest('signup', { email, password });
  if (data.access_token) window.localStorage.setItem(storageKey, JSON.stringify(data));
  return data;
}

export function signOut() {
  window.localStorage.removeItem(storageKey);
}

if (authConfigured) {
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('/api/')) {
      const session = getSession();
      if (session?.access_token) {
        const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
        if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${session.access_token}`);
        return nativeFetch(input, { ...init, headers });
      }
    }
    return nativeFetch(input, init);
  };
}
