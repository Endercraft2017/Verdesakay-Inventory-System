/**
 * Which device a request came from — for session history, the activity log and punch flags.
 *
 * The device ID is a random value each browser / installed app generates once and keeps in
 * localStorage (`vds_device_id`, set by public/js/api.js), sent as `X-Device-Id`. It is NOT a
 * fingerprint: nothing about the hardware or browser is read, and clearing site data simply
 * gives the device a new ID. It survives sign-out on purpose — it names the device, while the
 * session names the person — so "Ana signed in on the phone Ben usually uses" is visible.
 *
 * Anonymous-report requests never reach code that reads these (app.ts exempts that path from
 * the activity log, and the client does not send the header there).
 */
import type { Request } from 'express';

const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const UA_MAX = 300;

/** The caller's device ID, or null when absent/malformed. */
export function deviceIdOf(req: Request): string | null {
  const raw = req.get('x-device-id');
  return raw && DEVICE_ID_RE.test(raw) ? raw : null;
}

/** True when the request came from the phone app (/m sends `X-Client: mobile`, public/js/api.js).
 *  For rules only the phone app is held to — evidence photos on QC/QA results and on the release
 *  handoff. A self-declared header: it identifies the app, it doesn't authenticate it. */
export function isMobileClient(req: Request): boolean {
  return (req.get('x-client') || '').toLowerCase() === 'mobile';
}

/** Client IP (the proxy's X-Forwarded-For when BEHIND_PROXY — see app.ts `trust proxy`). */
export function clientIpOf(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

/** The User-Agent, trimmed to a sane length for storage. */
export function userAgentOf(req: Request): string | null {
  const ua = req.get('user-agent');
  return ua ? ua.slice(0, UA_MAX) : null;
}

/** A human label for a User-Agent, e.g. "Chrome on Android", "Safari on iPhone". */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const os =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}
