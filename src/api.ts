const hostedApi = import.meta.env.VITE_DESK_API?.trim().replace(/\/+$/, '');
const sessionKey = `conference-desk.session:${hostedApi}`;

export const hostedDesk = Boolean(hostedApi);
export const deskSessionEvent = 'conference-desk:session';
let memorySession: string | undefined;

export function getDeskSession() {
  if (!hostedDesk) return undefined;
  try { return sessionStorage.getItem(sessionKey) ?? undefined; }
  catch { return memorySession; }
}

export function setDeskSession(token?: string, expired = false) {
  if (!hostedDesk) return;
  memorySession = token;
  try {
    if (token) sessionStorage.setItem(sessionKey, token);
    else sessionStorage.removeItem(sessionKey);
  } catch { /* The current page can use the session if browser storage is unavailable. */ }
  window.dispatchEvent(new CustomEvent(deskSessionEvent, { detail: { expired } }));
}

export function deskReturnUrl(hash = window.location.hash) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = hash;
  return url.href;
}

export async function api<T>(route: string, body?: object, unauthenticated = false): Promise<T> {
  const token = hostedDesk && !unauthenticated ? getDeskSession() : undefined;
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const result = await fetch((hostedApi || '/api') + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(hostedDesk ? { cache: 'no-store', credentials: 'omit', redirect: 'error' } as const : {}),
  });
  if (hostedDesk && result.status === 401 && !unauthenticated && token && getDeskSession() === token) setDeskSession(undefined, true);
  if (result.status === 204) return undefined as T;
  const value = await result.json().catch(() => null);
  if (!result.ok) throw new Error(value?.error || value?.message || 'The request failed. Try again.');
  if (value === null) throw new Error('Conference Desk could not read the server response.');
  return value as T;
}
