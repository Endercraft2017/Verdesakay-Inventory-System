/**
 * Web-push notifications for the mobile app (/m).
 *
 * VAPID keys are generated once and kept in the `settings` k/v store (per-tenant
 * for free). Devices register a PushSubscription via /api/push; `notifyUser`
 * first records the notification in the person's history (`notifications`, read via
 * /api/notifications) and then fans the payload out to their subscriptions, pruning dead ones.
 * A payload without a record of its own to open (no `url`) opens that very notification
 * (`#/notifications?id=`); `link` is where the desktop opens it.
 *
 * Under NODE_ENV=test nothing hits the network — sends are recorded in
 * `__sentPush` so tests can assert intent.
 */
import webpush from 'web-push';
import { getSetting, setSetting, queryAll, run } from './db';
import { userPermissions } from './roles';
import type { Permission, Role } from './types';
import { sideEffectsSuppressed } from './sync-context';

const VAPID_KEY = 'vapid_keys';
const SUBJECT_KEY = 'push_subject';

interface VapidKeys { publicKey: string; privateKey: string }

function vapid(): VapidKeys {
  let k = getSetting<VapidKeys>(VAPID_KEY);
  if (!k || !k.publicKey || !k.privateKey) {
    k = webpush.generateVAPIDKeys();
    setSetting(VAPID_KEY, k);
  }
  return k;
}

export function vapidPublicKey(): string {
  return vapid().publicKey;
}

function configure(): void {
  const k = vapid();
  const subject = getSetting<string>(SUBJECT_KEY) || 'mailto:notify@otom.local';
  webpush.setVapidDetails(subject, k.publicKey, k.privateKey);
}

export interface PushPayload {
  title: string;
  body: string;
  /** Hash route inside /m to open on tap, e.g. '#/low-stock'. */
  url?: string;
  /** Collapse key — a newer notification with the same tag replaces the old one. */
  tag?: string;
  /** Desktop screen for the record (App.navigate(route, params)), kept with the history row. */
  link?: { route: string; params?: Record<string, unknown> };
  /** false: push only, no history row (chat messages have the inbox; test pushes). */
  record?: boolean;
}

/** Keep one notification in the person's history; returns its id (null if it can't be saved). */
function recordNotification(userId: number, payload: PushPayload): number | null {
  try {
    const id = Number(run(
      'INSERT INTO notifications (user_id, title, body, url, link, tag) VALUES (?, ?, ?, ?, ?, ?)',
      userId, payload.title, payload.body ?? null, payload.url ?? null, payload.link ? JSON.stringify(payload.link) : null, payload.tag ?? null
    ).lastInsertRowid);
    // Bounded history: older than 120 days goes.
    run("DELETE FROM notifications WHERE user_id = ? AND created_at < datetime('now', '-120 days')", userId);
    return id;
  } catch {
    return null; // a notification is never worth breaking a request
  }
}

interface SubRow { id: number; endpoint: string; p256dh: string; auth: string }

/** Test-mode capture: [{ userId, payload, endpoint }]. Cleared by tests as needed. */
export const __sentPush: Array<{ userId: number; payload: PushPayload; endpoint: string }> = [];

/** Send `payload` to every registered device of `userId`. Never throws. */
export async function notifyUser(userId: number, payload: PushPayload): Promise<void> {
  if (sideEffectsSuppressed('push')) return; // the authority notifies once, on replay
  const nid = payload.record === false ? null : recordNotification(userId, payload);
  if (!payload.url || payload.url === '#/notifications') {
    payload = { ...payload, url: nid ? `#/notifications?id=${nid}` : '#/notifications' };
  }
  const subs = queryAll<SubRow>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    userId
  );
  if (!subs.length) return;

  if (process.env.NODE_ENV === 'test') {
    for (const s of subs) __sentPush.push({ userId, payload, endpoint: s.endpoint });
    return;
  }

  configure();
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 60 * 60 * 24, urgency: 'normal' }
        );
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          run('DELETE FROM push_subscriptions WHERE id = ?', s.id); // subscription expired
        }
        // other failures: swallow — a notification is never worth breaking a request
      }
    })
  );
}

/** Fan a payload out to every active user whose effective permissions include `perm`. */
export async function notifyPermission(perm: Permission, payload: PushPayload): Promise<void> {
  const users = queryAll<{ id: number; role: Role; permission_overrides: string }>(
    'SELECT id, role, permission_overrides FROM users WHERE active = 1'
  );
  const targets = users.filter((u) => {
    let ov: Record<string, boolean> = {};
    try { ov = JSON.parse(u.permission_overrides || '{}') as Record<string, boolean>; } catch { /* none */ }
    return userPermissions(u.role, ov).includes(perm);
  });
  await Promise.all(targets.map((u) => notifyUser(u.id, payload)));
}

/** Fan a payload out once to every active user holding any of `perms`. */
export async function notifyAnyPermission(perms: Permission[], payload: PushPayload, exceptUserId?: number): Promise<void> {
  const users = queryAll<{ id: number; role: Role; permission_overrides: string }>(
    'SELECT id, role, permission_overrides FROM users WHERE active = 1'
  );
  const targets = users.filter((u) => {
    if (u.id === exceptUserId) return false;
    let ov: Record<string, boolean> = {};
    try { ov = JSON.parse(u.permission_overrides || '{}') as Record<string, boolean>; } catch { /* none */ }
    const has = userPermissions(u.role, ov);
    return perms.some((p) => has.includes(p));
  });
  await Promise.all(targets.map((u) => notifyUser(u.id, payload)));
}

/** Fan a payload out to every active user (opt-in "notify everyone" for announcements). */
export async function notifyAll(payload: PushPayload): Promise<void> {
  const users = queryAll<{ id: number }>('SELECT id FROM users WHERE active = 1');
  await Promise.all(users.map((u) => notifyUser(u.id, payload)));
}

/** One-shot task reminders. Call on a short interval (see server.ts). Fires a push
 *  for every due, not-yet-notified, not-done task, then marks it sent.
 *  Called inside each active tenant context by the cloud reminder timer. */
export async function sendDueTaskReminders(): Promise<void> {
  const due = queryAll<{ id: number; user_id: number; title: string }>(
    `SELECT id, user_id, title FROM tasks
     WHERE remind_at IS NOT NULL AND remind_sent = 0 AND done = 0
       AND CASE WHEN instr(remind_at, 'T') > 0 THEN datetime(remind_at) <= datetime('now')
                ELSE remind_at <= substr(datetime('now','localtime'), 1, 16) END`
  );
  for (const t of due) {
    run('UPDATE tasks SET remind_sent = 1 WHERE id = ?', t.id);
    await notifyUser(t.user_id, {
      title: 'Reminder', body: t.title, url: '#/tasks', link: { route: 'tasks' }, tag: 'task-' + t.id,
    });
  }
}

/** Called from the inventory routes after a change that lowers an item's grand total.
 *  Fires once, on the downward crossing of the reorder point. */
export function notifyLowStockCrossed(
  item: { id: number; name: string; min_quantity: number; unit: string | null },
  prevQty: number,
  newQty: number
): void {
  if (!(newQty <= item.min_quantity && prevQty > item.min_quantity)) return;
  void notifyPermission('inventory.adjust', {
    title: 'Low stock',
    body: `${item.name} is down to ${newQty} ${item.unit || ''} (reorder at ${item.min_quantity}).`,
    url: '#/low-stock',
    tag: 'low-stock-' + item.id,
  });
}
