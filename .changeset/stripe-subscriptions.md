---
"payweave": minor
---

Add the Stripe Billing P0 resources: `payweave.stripe.subscriptions` (create, retrieve, update, cancel, resume, list/iterate) and `payweave.stripe.subscriptionItems` (create, retrieve, update, delete, list/iterate) — PW-604.

Cancellation is exposed exactly as Stripe documents it: `subscriptions.cancel(id)` is the IMMEDIATE `DELETE /v1/subscriptions/{id}` (optional `invoice_now`/`prorate`/`cancellation_details`), while end-of-period cancellation is `subscriptions.update(id, { cancel_at_period_end: true })`. `subscriptions.resume(id)` acts on `status: "paused"` subscriptions only; paused payment COLLECTION is lifted via `update(id, { pause_collection: "" })`.

```ts
const sub = await payweave.stripe.subscriptions.create({
  customer: "cus_123",
  items: [{ price: "price_123", quantity: 1 }],
}, { idempotencyKey: "sub-cus_123-pro" });

// Period boundaries live on the items on the pinned API version:
const periodEnd = sub.items?.data[0]?.current_period_end;

for await (const item of payweave.stripe.subscriptionItems.iterate({ subscription: sub.id })) {
  console.log(item.id, item.price?.id);
}
```

Requests are form-encoded bracket notation (never JSON), request schemas parse before send, response schemas are loose (unknown Stripe fields pass through), and every list has a cursor iterator following `has_more` + `starting_after`.
