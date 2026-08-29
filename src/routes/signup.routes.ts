/** Self-serve tenant sign-up. Live only when SIGNUPS_OPEN=true; otherwise you provision
    tenants with `npm run tenant:create`. Runs on whatever tenant the request resolved to
    (normally the marketing/default site). See docs/SAAS-READINESS.md §11. */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { parseBody, signupSchema } from '../validation';
import { createTenant } from '../provisioning';
import { SIGNUPS_OPEN, APP_DOMAIN } from '../platform';

const router = Router();

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many sign-up attempts. Please try again later.' },
});

router.post('/', signupLimiter, (req, res, next) => {
  if (!SIGNUPS_OPEN) {
    res.status(404).json({ error: 'Sign-ups are not open.' });
    return;
  }
  try {
    const input = parseBody(signupSchema, req.body);
    const { slug } = createTenant({
      slug: input.slug,
      name: input.company_name,
      admin_username: input.admin_username,
      admin_password: input.admin_password,
      admin_email: input.admin_email,
      plan: 'trial',
      status: 'trial',
    });
    res.status(201).json({
      slug,
      url: APP_DOMAIN ? `https://${slug}.${APP_DOMAIN}` : `/?tenant=${slug}`,
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status && err.status < 500) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(e);
  }
});

export default router;
