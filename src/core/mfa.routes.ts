/** Own-account MFA lifecycle; passwords and factors never enter activity metadata. */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth, endUserSessions } from '../shared/auth';
import { clearBrowserSession } from '../shared/browser-session';
import { mfaState, startMfa, finishMfa, verifyMfa } from '../shared/mfa';
import { queryOne, run, tenantStore } from '../shared/db';
import { parseBody } from '../shared/validation';
import { syncClass } from '../sync';
const router = Router();
router.use(requireAuth);
router.use(rateLimit({ windowMs: 900_000, limit: 10, keyGenerator: req => crypto.createHash('sha256').update(`${tenantStore.getStore()?.slug}:${req.user!.id}`).digest('hex'), skip: () => process.env.NODE_ENV === 'test', standardHeaders: true, legacyHeaders: false }));
const proof = z.object({ current_password: z.string().min(1).max(200), code: z.string().min(1).max(24).optional() }).strict();
function checkPassword(id: number, password: string): boolean {
  const user = queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', id);
  return !!user && bcrypt.compareSync(password, user.password_hash);
}
router.get('/', (req, res) => {
  const state = mfaState(req.user!.id);
  res.json({ enabled: !!state?.secret, recovery_codes_remaining: state?.secret ? JSON.parse(state.recovery_hashes).length : 0 });
});
router.post('/setup', syncClass('online'), (req, res) => {
  const input = parseBody(proof, req.body);
  if (!checkPassword(req.user!.id, input.current_password)) { res.status(403).json({ error: 'Current password is incorrect.' }); return; }
  res.json(startMfa(req.user!.id, req.user!.username, req.token!));
});
router.post('/enable', syncClass('online'), (req, res) => {
  const input = parseBody(proof, req.body);
  if (!checkPassword(req.user!.id, input.current_password)) { res.status(403).json({ error: 'Current password is incorrect.' }); return; }
  const codes = finishMfa(req.user!.id, req.token!, input.code || '');
  if (!codes) { res.status(400).json({ error: 'Code invalid, already used, or setup expired. Start again if needed.' }); return; }
  endUserSessions(req.user!.id, 'revoked'); clearBrowserSession(res);
  res.json({ enabled: true, recovery_codes: codes, sign_in_required: true });
});
router.post('/disable', syncClass('online'), (req, res) => {
  const input = parseBody(proof, req.body);
  if (!checkPassword(req.user!.id, input.current_password) || !verifyMfa(req.user!.id, input.code || '')) { res.status(403).json({ error: 'Current password and a fresh authenticator or recovery code are required.' }); return; }
  run('DELETE FROM user_mfa WHERE user_id = ?', req.user!.id);
  endUserSessions(req.user!.id, 'revoked'); clearBrowserSession(res);
  res.json({ enabled: false, sign_in_required: true });
});
export default router;
