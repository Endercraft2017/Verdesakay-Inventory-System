/** Web-push: expose the VAPID public key, register / drop a device subscription,
 *  send a test notification to the caller's own devices. Any logged-in user manages
 *  only their own subscriptions — no extra permission needed. */
import { Router } from 'express';
import { queryOne, run } from '../shared/db';
import { requireAuth } from '../shared/auth';
import { parseBody, pushSubscriptionSchema, pushUnsubscribeSchema } from '../shared/validation';
import { vapidPublicKey, notifyUser } from '../shared/push';

const router = Router();
router.use(requireAuth);

// GET /api/push/key — the VAPID public key the client needs to subscribe.
router.get('/key', (_req, res) => {
  res.json({ key: vapidPublicKey() });
});

// POST /api/push/subscribe — upsert this device's PushSubscription for the caller.
router.post('/subscribe', (req, res) => {
  const sub = parseBody(pushSubscriptionSchema, req.body);
  run(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh,
       auth = excluded.auth, user_agent = excluded.user_agent`,
    req.user!.id,
    sub.endpoint,
    sub.keys.p256dh,
    sub.keys.auth,
    (req.get('user-agent') || '').slice(0, 300)
  );
  res.status(201).json({ ok: true });
});

// POST /api/push/unsubscribe — drop one subscription (only the caller's own).
router.post('/unsubscribe', (req, res) => {
  const { endpoint } = parseBody(pushUnsubscribeSchema, req.body);
  run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, req.user!.id);
  res.json({ ok: true });
});

// GET /api/push/status — does the caller have any device registered?
router.get('/status', (req, res) => {
  const n = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?',
    req.user!.id
  )?.n ?? 0;
  res.json({ subscriptions: n });
});

// POST /api/push/test — send a test notification to the caller's devices.
router.post('/test', async (req, res) => {
  await notifyUser(req.user!.id, {
    title: 'Verdesakay Warehouse',
    body: 'Notifications are working. 🎉',
    url: '#/home',
    tag: 'push-test',
  });
  res.json({ ok: true });
});

export default router;
