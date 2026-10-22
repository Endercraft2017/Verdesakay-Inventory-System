# Hosted payments for OTOM SaaS

Status: provisional evaluation, 9 October 2026 (Philippines). Live verification is
blocked: official PayMongo, Xendit and Stripe pages returned HTTP 403 from the
execution environment's network proxy, including after network permission was
granted. No current fees, onboarding eligibility or Philippine recurring payment
method availability have been verified. No provider account has been created.

## Recommendation to validate

For a Philippine business primarily serving Philippine customers, evaluate
**Xendit first**, with **PayMongo** as the local comparison. Require a provider-hosted
checkout/enrollment flow and automatic recurring card billing. Treat GCash as a
separate payment-method question: accepting a one-time GCash payment is not proof
that automatic recurring GCash debits are available to this merchant.

If international SaaS sales and outsourced tax administration are the priority,
also evaluate **Paddle**, a merchant-of-record model with hosted checkout and
subscriptions. Confirm Philippine seller onboarding, payouts and product approval;
do not assume GCash is offered. Stripe Checkout/Billing is a strong subscription
option where the seller's business can actually open a supported Stripe account;
accepting payments from Filipino customers does not establish Philippine merchant
eligibility.

## Questions that decide the choice

- Can a Philippine registered business of our type onboard and receive PHP payouts?
  What is the route for an individual/sole proprietor?
- Is there hosted checkout for a subscription with a variable server-calculated
  amount (selected module prices plus seat/employee allowance)? Is a distinct plan
  required for each negotiated subscription?
- Which methods support automatic monthly recurring charges **in the Philippines**?
  Specifically distinguish cards, GCash, Maya and manually paid renewal links.
- What are the current method-specific fees, VAT on fees, recurring-billing fees,
  settlement time, payout fees, refunds and chargeback costs?
- Can customers manage their method, cancel and retrieve invoices through a hosted
  portal? Are upgrade/downgrade, proration, retry/dunning and webhook events supported?
- What happens to a subscription when its wallet authorization expires or a card
  renewal fails? Can the provider fall back to hosted renewal links?

## App flow (no custom payment-entry page)

1. OTOM shows feature/module selection and separate login seats/HR employee allowance.
2. Server validates dependencies and looks up a published pricing catalog. The
   browser cannot set payable prices. Existing per-tenant owner quotes are not yet
   a public, customer-editable pricing catalog.
3. Create a pending signup and a provider-hosted subscription checkout session;
   redirect the customer to the provider. Do not collect card/wallet credentials.
4. A signature-verified, idempotently processed payment webhook activates the tenant
   and stores provider customer/subscription IDs. A success-page redirect alone must
   not activate it. Preserve pending signup identity on retries.
5. Verified renewal/failure/cancellation events update paid-through dates and
   entitlement/status transitions. Changes to modules or capacity take effect
   according to the paid subscription, with explicit downgrade rules that never
   delete company data. Use the provider's portal where available.

## Official sources to verify

These are source links for follow-up, not evidence of a successful live fetch.

- Xendit documentation: https://docs.xendit.co/ ; Philippine pricing:
  https://www.xendit.co/en-ph/pricing/
- PayMongo documentation: https://docs.paymongo.com/ ; pricing:
  https://www.paymongo.com/pricing
- Stripe supported merchant countries: https://stripe.com/global ; hosted
  subscription Checkout: https://docs.stripe.com/payments/checkout/build-subscriptions
- Paddle hosted checkout: https://developer.paddle.com/build/checkout/build-overlay-checkout ;
  seller eligibility and commercial terms: https://www.paddle.com/
