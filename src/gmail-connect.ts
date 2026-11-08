import { api } from './api';

export const gmailConnectRoute = 'connect-gmail';
const callbackPath = '/api/gmail/callback';

export function defaultGmailCallback() {
  return window.location.origin.replace('://localhost', '://127.0.0.1') + callbackPath;
}

export async function startGmailConnection(redirectUri?: string) {
  let callback: URL;
  try {
    callback = new URL(redirectUri || defaultGmailCallback());
    if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(callback.hostname) ||
        callback.port !== window.location.port || callback.pathname !== callbackPath ||
        callback.username || callback.password || callback.search || callback.hash) throw new Error();
  } catch {
    throw new Error('Gmail needs the local callback URL shown in Connections. Check GMAIL_REDIRECT_URI and restart Conference Desk.');
  }

  if (window.location.origin !== callback.origin) {
    // Google returns to the callback host, so the authorization cookie must be set there.
    window.location.assign(callback.origin + '/#' + gmailConnectRoute);
    return;
  }

  const { url } = await api<{ url: string }>('/gmail/connect', {});
  let authorization: URL;
  try {
    authorization = new URL(url);
    if (authorization.origin !== 'https://accounts.google.com' || authorization.pathname !== '/o/oauth2/v2/auth' ||
        authorization.username || authorization.password || authorization.searchParams.get('redirect_uri') !== callback.href) throw new Error();
  } catch {
    throw new Error('Conference Desk received an invalid Google authorization link. Check the Gmail OAuth settings and try again.');
  }
  window.location.assign(authorization.href);
}
