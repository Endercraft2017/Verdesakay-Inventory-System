/**
 * Web-push notifications for the mobile app (/m).
 *
 * VAPID keys are generated once and kept in the `settings` k/v store (per-tenant
 * for free). Devices register a PushSubscription via /api/push; `notifyUser`
 * fans a payload out to that user's subscriptions and prunes dead ones.
 *
 * Under NODE_ENV=test nothing hits the network — sends are recorded in
 * `__sentPush` so tests can assert intent.
 */
import webpush from 'web-push';
import { getSetting, setSetting, queryAll, run } from './db';
import { resolvePermissions } from './permissions';
import type { Permission, Role } from './types';

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
}

interface SubRow { id: number; endpoint: string; p256dh: string; auth: string }

/** Test-mode capture: [{ userId, payload, endpoint }]. Cleared by tests as needed. */
export const __sentPush: Array<{ userId: number; payload: PushPayload; endpoint: string }> = [];

/** Send `payload` to every registered device of `userId`. Never throws. */
export async function notifyUser(userId: number, payload: PushPayload): Promise<void> {
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
    return resolvePermissions(u.role, ov).includes(perm);
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
 *  (Default tenant only — same scope as cleanupSessions.) */
export async function sendDueTaskReminders(): Promise<void> {
  const due = queryAll<{ id: number; user_id: number; title: string }>(
    `SELECT id, user_id, title FROM tasks
     WHERE remind_at IS NOT NULL AND remind_sent = 0 AND done = 0
       AND remind_at <= substr(datetime('now','localtime'), 1, 16)`
  );
  for (const t of due) {
    run('UPDATE tasks SET remind_sent = 1 WHERE id = ?', t.id);
    await notifyUser(t.user_id, {
      title: 'Reminder', body: t.title, url: '#/tasks', tag: 'task-' + t.id,
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
