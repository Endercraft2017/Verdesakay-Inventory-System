/** GET /api/tenant — the current workspace's plan / status / trial info, so the
    frontend can show a trial-countdown or past-due banner. Usage figures are
    included for `users.manage`. Single-tenant (`default`) reports plan `unlimited`. */
import { Router } from 'express';
import { requireAuth } from '../auth';
import { getTenant } from '../platform';
import { planFor, tenantUsage, currentSlug } from '../quota';
import { DEFAULT_TENANT } from '../db';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const slug = currentSlug();
  const t = slug === DEFAULT_TENANT ? null : getTenant(slug);
  const { plan, limits } = planFor(slug);

  const lapsedTrial = !!t && t.status === 'trial' && !!t.trial_ends_at
    && t.trial_ends_at < new Date().toISOString();
  const trialDaysLeft = t && t.status === 'trial' && t.trial_ends_at
    ? Math.ceil((Date.parse(t.trial_ends_at) - Date.now()) / 86_400_000)
    : null;

  const body: Record<string, unknown> = {
    slug,
    name: t?.name ?? 'Workspace',
    plan,
    status: lapsedTrial ? 'past_due' : (t?.status ?? 'active'),
    trial_ends_at: t?.trial_ends_at ?? null,
    trial_days_left: trialDaysLeft,
    read_only: !!t && (t.status === 'past_due' || lapsedTrial),
    limits,
  };
  if (req.user!.permissions.includes('users.manage')) {
    body.usage = tenantUsage(slug);
  }
  res.json(body);
});

export default router;
