import { prepareSignupReceipt, saveCreationReceipt } from './onboarding-receipts';
/** Self-serve tenant sign-up. Live only when SIGNUPS_OPEN=true; otherwise you provision
    tenants with `npm run tenant:create`. Runs on whatever tenant the request resolved to
    (normally the marketing/default site). See docs/SAAS-READINESS.md §11–12.

    Pay first: the workspace is created locked (`awaiting_payment`) with its quote priced from the
    billing price list, and — when the list covers every chosen module and the seat price — its
    first month's invoice. It opens when an operator confirms that payment (billing.ts). */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { parseBody, signupSchema } from '../shared/validation';
import { saveSubscription } from './subscription';
import { saveOwnerDetails, prepareOwnerAnalytics } from './owner-analytics';
import { planModules } from './plans';
import { createTenantForPublicSignup } from './provisioning';
import { SIGNUPS_OPEN, tenantPublicUrl, getTenant, setAwaitingPayment } from './platform';
import { getBillingSettings, priceListQuote, createInvoice, invoiceView } from './billing';
import { rateLimitKey } from '../shared/device';
import { prepareOwnerAlerts, enqueueSignupAlert } from './owner-alert-outbox';
import { PasswordWorkBusyError } from '../shared/password-work';
import { forwardControlPlaneError } from './request-errors';

const ymd = (d: Date) => d.toISOString().slice(0, 10);

const router = Router();

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false, keyGenerator: rateLimitKey,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many sign-up attempts. Please try again later.' },
});

let signupActive=false; // One active public request per process; no signup backlog.
router.post('/', signupLimiter, async (req, res, next) => {
  res.set('Cache-Control','no-store');
  if (!SIGNUPS_OPEN) {
    res.status(404).json({ error: 'Sign-ups are not open.' });
    return;
  }
  try {
    const input = parseBody(signupSchema, req.body);
    if(signupActive){res.set('Retry-After','5').status(503).json({error:'Registration is busy. Try again shortly.'});return;}
    signupActive=true;
    try {
    const receipt = await prepareSignupReceipt(req.get('Idempotency-Key'), input);
    if (receipt?.replay) { res.set('Idempotency-Replayed', 'true').status(201).json(receipt.replay); return; }
    const seats = input.seats ?? 5;
    const prices = getBillingSettings();
    const quote = priceListQuote(input.modules ?? planModules('starter'), seats, prices);
    const modulePrices: Record<string, number> = {};
    for (const m of quote.modules) if (typeof prices.module_prices[m] === 'number') modulePrices[m] = prices.module_prices[m]!;
    prepareOwnerAnalytics();
    prepareOwnerAlerts();
    const result: { invoice: ReturnType<typeof invoiceView> | null; response?: unknown } = { invoice: null };
    await createTenantForPublicSignup({
      slug: input.slug,
      name: input.company_name,
      admin_username: input.admin_username,
      admin_password: input.admin_password,
      admin_email: input.admin_email,
      plan: 'complete',
      status: 'active',
    }, slug => {
      setAwaitingPayment(slug, true);
      saveSubscription(slug, { mode: 'per_module', bundle: 'complete', modules: quote.modules,
        seat_limit: seats, seat_price: prices.seat_price, bundle_price: null, module_prices: modulePrices });
      saveOwnerDetails(slug, { contact_name: input.admin_username, contact_email: input.admin_email ?? '' });
      // The first month's invoice, when the price list covers this order; otherwise an operator issues it.
      if (quote.total_centavos !== null && quote.total_centavos > 0) {
        const start = new Date();
        const end = new Date(start); end.setMonth(end.getMonth() + 1); end.setDate(end.getDate() - 1);
        const due = new Date(start); due.setDate(due.getDate() + 7);
        result.invoice = invoiceView(createInvoice(slug, {
          kind: 'subscription',
          description: `First month — ${quote.modules.join(', ')} · ${seats} login seat${seats === 1 ? '' : 's'}`,
          amount_centavos: quote.total_centavos,
          due_on: ymd(due), period_start: ymd(start), period_end: ymd(end),
        }, 'signup'));
      }
      const invoice = result.invoice;
      result.response = {
        slug, url: tenantPublicUrl(slug), company_id: getTenant(slug)?.company_id, awaiting_payment: true,
        invoice: invoice && { reference: invoice.reference, amount: invoice.amount, net_if_withheld: invoice.net_if_withheld, due_on: invoice.due_on },
      };
      saveCreationReceipt(receipt, slug, result.response);
      enqueueSignupAlert(slug, `New sign-up: ${input.company_name}`, [
        `${input.company_name} signed up on the website (/${slug}) and is waiting to pay.`,
        input.admin_email ? `Email: ${input.admin_email}` : '',
        invoice ? `First invoice ${invoice.reference}: ₱${invoice.amount}` : 'No invoice yet — issue one in Billing.',
      ]);
    });
    res.status(201).json(result.response);
    } finally {signupActive=false;}
  } catch (error) {
    if(error instanceof PasswordWorkBusyError){res.set('Retry-After','5').status(503).json({error:'Registration is busy. Try again shortly.'});return;}
    forwardControlPlaneError(error, next);
  }
});

export default router;
