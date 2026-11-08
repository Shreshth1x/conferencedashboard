import { api, deskReturnUrl, hostedDesk } from './api';

export const gmailConnectRoute = 'connect-gmail';
const callbackPath = '/api/gmail/callback';

export function defaultGmailCallback() {
  return window.location.origin.replace('://localhost', '://127.0.0.1') + callbackPath;
}

function openGoogleConsent(url: string, redirectUri?: string) {
  let authorization: URL;
  try {
    authorization = new URL(url);
    if (authorization.origin !== 'https://accounts.google.com' || authorization.pathname !== '/o/oauth2/v2/auth' ||
        authorization.username || authorization.password ||
        (redirectUri && authorization.searchParams.get('redirect_uri') !== redirectUri)) throw new Error();
  } catch {
    throw new Error('Conference Desk received an invalid Google authorization link. Try again or check the Google OAuth configuration.');
  }
  window.location.assign(authorization.href);
}

export async function startOwnerSignIn() {
  const { url } = await api<{ url: string }>('/session/start', { returnUrl: deskReturnUrl() }, true);
  openGoogleConsent(url);
}

export async function startGmailConnection(redirectUri?: string) {
  if (hostedDesk) {
    const { url } = await api<{ url: string }>('/gmail/connect', { returnUrl: deskReturnUrl('#connections') });
    openGoogleConsent(url, redirectUri);
    return;
  }

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
  openGoogleConsent(url, callback.href);
}
