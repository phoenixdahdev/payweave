import { randomUUID } from "node:crypto"

import { Body, Controller, Get, Header, HttpStatus, Post, Query, Res } from "@nestjs/common"
import type { Response } from "express"
import { PayweaveError } from "payweave"

import { PayweaveService } from "../payweave/payweave.service.js"

const PORT = Number(process.env.PORT) || 3000

// A real app would look this up from a product/price catalog rather than
// trust client input. Payweave amounts are ALWAYS integer minor units — this
// is ₦5,000.00, never a float.
const DEMO_AMOUNT = { value: 500_000, currency: "NGN" }

@Controller()
export class CheckoutController {
  constructor(private readonly payweaveService: PayweaveService) {}

  @Get()
  @Header("Content-Type", "text/html")
  index(): string {
    return page(
      "Payweave + Flutterwave demo checkout",
      `
      <h1>Payweave + Flutterwave demo checkout</h1>
      <p>
        This minimal example creates a Payweave checkout session backed by Flutterwave for a fixed
        &#8358;5,000.00 demo charge, then redirects you there to pay.
      </p>
      <form action="/checkout" method="POST">
        <label for="email">Email</label><br />
        <input id="email" name="email" type="email" placeholder="ada@example.com" required />
        <button type="submit">Pay &#8358;5,000.00</button>
      </form>
      `,
    )
  }

  @Post("checkout")
  async checkout(@Body("email") email: unknown, @Res() res: Response): Promise<void> {
    if (typeof email !== "string" || email.length === 0) {
      res.status(HttpStatus.BAD_REQUEST).send("Email is required")
      return
    }

    // Our own idempotent order reference, baked into the redirect URL's query
    // string ourselves and reused by the callback route below. We don't rely
    // on the provider's own redirect query param to carry it — Flutterwave's
    // is `tx_ref`, Paystack's is `reference`, Stripe has none by default — so
    // generating and threading our own keeps this route provider-portable.
    const reference = `order_${randomUUID()}`
    const redirectUrl = new URL(`http://localhost:${PORT}/checkout/callback`)
    redirectUrl.searchParams.set("reference", reference)

    try {
      const checkout = await this.payweaveService.client.checkout.create({
        amount: DEMO_AMOUNT,
        customer: { email },
        reference,
        redirectUrl: redirectUrl.toString(),
      })

      // Never grant value here — this only sends the customer to Flutterwave.
      // The callback route re-verifies before the order is treated as paid.
      res.redirect(302, checkout.checkoutUrl)
    } catch (error) {
      if (error instanceof PayweaveError) {
        console.error("[payweave] checkout.create failed:", error.toJSON())
        res.status(HttpStatus.BAD_GATEWAY).send("Could not start checkout. Please try again.")
        return
      }
      throw error
    }
  }

  /**
   * Flutterwave redirects the customer back here (see `redirectUrl` above).
   * We re-verify with Payweave before deciding whether the order was actually
   * paid — the query string alone (ours, or Flutterwave's own `status`/
   * `tx_ref`) is never trusted for that.
   */
  @Get("checkout/callback")
  @Header("Content-Type", "text/html")
  async callback(
    @Query("reference") reference: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    if (typeof reference !== "string" || reference.length === 0) {
      res.status(HttpStatus.BAD_REQUEST)
      return page("Payment status unknown", "<h1>Payment status unknown</h1><p>Missing reference.</p>")
    }

    try {
      const result = await this.payweaveService.client.verify({ reference })

      if (result.status === "success") {
        return page(
          "Payment successful",
          `
          <h1 class="status-success">Payment successful</h1>
          <p>Reference: <code>${escapeHtml(reference)}</code></p>
          <p>Amount: ${result.amount.value} ${escapeHtml(result.amount.currency)} (minor units)</p>
          <p><a href="/">Back to demo</a></p>
          `,
        )
      }

      return page(
        "Payment not completed",
        `
        <h1 class="status-failed">Payment ${escapeHtml(result.status)}</h1>
        <p>Reference: <code>${escapeHtml(reference)}</code></p>
        <p><a href="/">Try again</a></p>
        `,
      )
    } catch (error) {
      if (error instanceof PayweaveError) {
        console.error("[payweave] verify failed:", error.toJSON())
        res.status(HttpStatus.BAD_GATEWAY)
        return page(
          "Something went wrong",
          `<h1 class="status-failed">Something went wrong</h1><p>We could not verify this payment. Please try again shortly.</p>`,
        )
      }
      throw error
    }
  }
}

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
