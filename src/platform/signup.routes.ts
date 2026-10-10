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
import { saveOwnerDetails } from './owner-analytics';
import { planModules } from './plans';
import { createTenant } from './provisioning';
import { SIGNUPS_OPEN, tenantPublicUrl, setAwaitingPayment } from './platform';
import { getBillingSettings, priceListQuote, createInvoice, invoiceView } from './billing';

const ymd = (d: Date) => d.toISOString().slice(0, 10);

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
      plan: 'complete',
      status: 'active',
    });
    setAwaitingPayment(slug, true);
    const seats = input.seats ?? 5;
    const prices = getBillingSettings();
    const quote = priceListQuote(input.modules ?? planModules('starter'), seats, prices);
    const modulePrices: Record<string, number> = {};
    for (const m of quote.modules) if (typeof prices.module_prices[m] === 'number') modulePrices[m] = prices.module_prices[m]!;
    saveSubscription(slug, { mode: 'per_module', bundle: 'complete', modules: quote.modules,
      seat_limit: seats, seat_price: prices.seat_price, bundle_price: null, module_prices: modulePrices });
    saveOwnerDetails(slug, { contact_name: input.admin_username, contact_email: input.admin_email ?? '' });
    // The first month's invoice, when the price list covers this order; otherwise an operator issues it.
    let invoice = null;
    if (quote.total_centavos !== null && quote.total_centavos > 0) {
      const start = new Date();
      const end = new Date(start); end.setMonth(end.getMonth() + 1); end.setDate(end.getDate() - 1);
      const due = new Date(start); due.setDate(due.getDate() + 7);
      invoice = invoiceView(createInvoice(slug, {
        kind: 'subscription',
        description: `First month — ${quote.modules.join(', ')} · ${seats} login seat${seats === 1 ? '' : 's'}`,
        amount_centavos: quote.total_centavos,
        due_on: ymd(due), period_start: ymd(start), period_end: ymd(end),
      }, 'signup'));
    }
    res.status(201).json({
      slug,
      url: tenantPublicUrl(slug),
      awaiting_payment: true,
      invoice: invoice && { reference: invoice.reference, amount: invoice.amount, net_if_withheld: invoice.net_if_withheld, due_on: invoice.due_on },
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
