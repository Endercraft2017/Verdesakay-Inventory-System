/** Only browser push services, never a caller-selected generic HTTPS target. */
export function validPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    const host = url.hostname.toLowerCase();
    return host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
      || host === 'web.push.apple.com' || host.endsWith('.notify.windows.com');
  } catch { return false; }
}
