import express from "express"
import { PayweaveError } from "payweave"

import { payweave } from "./payweave.js"

const PORT = Number(process.env.PORT) || 3000

// A real app would look this up from a product/price catalog rather than
// trust client input. Payweave amounts are ALWAYS integer minor units — this
// is ₦5,000.00, never a float.
const DEMO_AMOUNT = { value: 500_000, currency: "NGN" }

const app = express()

/**
 * The Paystack webhook endpoint.
 *
 * This route — and its dedicated `express.raw()` parser — is declared BEFORE
 * `express.json()` / `express.urlencoded()` are mounted below, and on
 * purpose: Paystack sends webhook requests with `Content-Type:
 * application/json`, and Express runs middleware in registration order for
 * every request that matches, regardless of path. If a global JSON parser
 * were mounted first, it would consume and re-encode this route's body
 * before `express.raw()` ever saw it — and signature verification (which
 * MUST run over the exact bytes Paystack sent, never a re-parsed/
 * re-stringified body) would always fail. Declaring `/webhooks` first, with
 * its own dedicated raw-body parser (matching any content type, below),
 * guarantees it always gets the untouched raw body: this handler always
 * sends a response and never calls `next()`, so the global parsers mounted
 * afterward never run for this path.
 */
app.post("/webhooks", express.raw({ type: "*/*" }), (req, res) => {
  let event
  try {
    event = payweave.webhooks.constructEvent({
      rawBody: req.body,
      headers: req.headers,
    })
  } catch {
    // A bad/missing x-paystack-signature throws PayweaveWebhookVerificationError.
    res.sendStatus(400)
    return
  }

  // Ack fast, then handle.
  res.sendStatus(200)

  switch (event.unifiedType) {
    case "payment.succeeded":
      // Re-verify via payweave.verify({ reference }) before fulfilling —
      // never trust the webhook body alone.
      console.log(`[payweave] payment.succeeded (dedupeKey=${event.dedupeKey})`)
      break
    case "payment.failed":
      console.log(`[payweave] payment.failed (dedupeKey=${event.dedupeKey})`)
      break
    default:
      console.log(`[payweave] unhandled event: ${event.unifiedType}`)
  }
})

// Body parsers for every other route below. Never applied to /webhooks —
// see the comment above.
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.get("/", (_req, res) => {
  res.type("html").send(
    page(
      "Payweave + Paystack demo checkout",
      `
      <h1>Payweave + Paystack demo checkout</h1>
      <p>
        This minimal example creates a Payweave checkout session backed by Paystack for a fixed
        &#8358;5,000.00 demo charge, then redirects you there to pay.
      </p>
      <form action="/checkout" method="POST">
        <label for="email">Email</label><br />
        <input id="email" name="email" type="email" placeholder="ada@example.com" required />
        <button type="submit">Pay &#8358;5,000.00</button>
      </form>
      `,
    ),
  )
})

app.post("/checkout", async (req, res) => {
  const email = req.body?.email

  if (typeof email !== "string" || email.length === 0) {
    res.status(400).send("Email is required")
    return
  }

  try {
    const checkout = await payweave.checkout.create({
      amount: DEMO_AMOUNT,
      customer: { email },
      redirectUrl: `http://localhost:${PORT}/checkout/callback`,
    })

    // Never grant value here — this only sends the customer to Paystack. The
    // callback route re-verifies before the order is treated as paid.
    res.redirect(302, checkout.checkoutUrl)
  } catch (error) {
    if (error instanceof PayweaveError) {
      console.error("[payweave] checkout.create failed:", error.toJSON())
      res.status(502).send("Could not start checkout. Please try again.")
      return
    }
    throw error
  }
})

/**
 * Paystack redirects the customer back here (see `redirectUrl` above),
 * appending `?reference=...` (and `trxref=...`) itself. We re-verify with
 * Payweave before deciding whether the order was actually paid — the query
 * string alone is never trusted for that.
 */
app.get("/checkout/callback", async (req, res) => {
  const { reference } = req.query

  if (typeof reference !== "string" || reference.length === 0) {
    res
      .type("html")
      .status(400)
      .send(page("Payment status unknown", `<h1>Payment status unknown</h1><p>Missing reference.</p>`))
    return
  }

  try {
    const result = await payweave.verify({ reference })

    if (result.status === "success") {
      res.type("html").send(
        page(
          "Payment successful",
          `
          <h1 class="status-success">Payment successful</h1>
          <p>Reference: <code>${escapeHtml(reference)}</code></p>
          <p>Amount: ${result.amount.value} ${escapeHtml(result.amount.currency)} (minor units)</p>
          <p><a href="/">Back to demo</a></p>
          `,
        ),
      )
      return
    }

    res.type("html").send(
      page(
        "Payment not completed",
        `
        <h1 class="status-failed">Payment ${escapeHtml(result.status)}</h1>
        <p>Reference: <code>${escapeHtml(reference)}</code></p>
        <p><a href="/">Try again</a></p>
        `,
      ),
    )
  } catch (error) {
    if (error instanceof PayweaveError) {
      console.error("[payweave] verify failed:", error.toJSON())
      res
        .type("html")
        .status(502)
        .send(
          page(
            "Something went wrong",
            `<h1 class="status-failed">Something went wrong</h1><p>We could not verify this payment. Please try again shortly.</p>`,
          ),
        )
      return
    }
    throw error
  }
})

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
      input, button { font-size: 1rem; padding: 0.5rem; }
      button { cursor: pointer; }
      .status-success { color: #0a7d33; }
      .status-failed { color: #b3261e; }
    </style>
  </head>
  <body>
    ${bodyHtml}
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

app.listen(PORT, () => {
  console.log(`payweave-example-express listening on http://localhost:${PORT}`)
})
