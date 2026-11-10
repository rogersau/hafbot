---
description: "Manage HAF Bot subscriptions, assigned Discord servers and the shared Premium Plus white-label identity. Understand payment recovery and cancellation."
---

# Billing and Guild Assignments

HAF Bot has three plans: Free, Premium, and Premium Plus. See [Compare Plans](/plans) for the current prices, features, and limits.

## Key Terms

- **Plan Owner** — the HAF account that buys and manages the subscription.
- **Guild Assignment** — the Discord server selected to receive paid features from that subscription.
- **Premium Plus** — covers up to three assigned Discord servers and includes one shared White-Label Bot identity.

Buying a subscription does not automatically move paid access between every server you manage. Confirm the intended server has a Guild Assignment in **Billing**.

## Assign a Server

1. Open **Admin Dashboard → Billing**.
2. Confirm the correct Plan Owner and subscription.
3. Choose an available Guild Assignment slot.
4. Select the Discord server that should receive paid features.
5. Confirm the server shows Premium or Premium Plus before enabling paid features.

Moving a Guild Assignment changes which server receives the subscription. It does not transfer ownership of the subscription.

## Premium Plus and White-Label Bots

Premium Plus provides the same per-server feature set as Premium for up to three assigned Discord servers.

It also includes one shared White-Label Bot identity. The same custom bot name and branding can be used on any or all assigned servers. White-label setup remains tied to the Plan Owner's active Premium Plus subscription.

## Checkout and Payments

Checkout, invoices, payment methods, and cancellation are handled through Stripe.

Prices are listed in AUD. Stripe may show a supported local currency or payment method based on location. Review the final Checkout total before confirming payment.

Stripe sends receipts and notices when a payment, renewal, required action, or cancellation changes. HAF may also show a private Billing notice in Discord or the dashboard.

## Failed Payments

When a renewal payment needs attention, **Billing** shows the recovery state and deadline.

Update the payment method through the Stripe Billing link before that deadline. Paid access remains available only for the grace period shown in Billing. If payment is not recovered, assigned servers return to the Free plan.

Saved configuration and existing records remain in HAF, but paid-only processing becomes inactive. Restoring a paid Guild Assignment reactivates the saved configuration for new activity. HAF does not process activity missed while the feature was inactive.

## Cancellation

Cancellation normally takes effect at the end of the paid period shown in Billing.

Until that date, assigned servers keep their paid access. Afterward, they return to Free limits and paid-only processing stops. Existing data follows the normal retention policy.

## Discord Roles Do Not Control Billing

Discord roles do not grant, restore, move, or permanently override a paid plan. Manage subscriptions and Guild Assignments through **Billing**.
