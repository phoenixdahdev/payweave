import { randomUUID } from "node:crypto"

import { redirect } from "next/navigation"
import { PayweaveError } from "payweave"

import { payweave } from "@/lib/payweave"

// A real app would look this up from a product/price catalog rather than
// trust client input. Payweave amounts are ALWAYS integer minor units — this
// is $20.00, never a float.
const DEMO_AMOUNT = { value: 2_000, currency: "USD" }

export async function POST(request: Request) {
  const formData = await request.formData()
  const email = formData.get("email")

  if (typeof email !== "string" || email.length === 0) {
    return new Response("Email is required", { status: 400 })
  }

  // Our own idempotent order reference — reused as the query param the
  // callback route reads back below, so we can verify the same order.
  const reference = `order_${randomUUID()}`
  const redirectUrl = new URL("/checkout/callback", request.url)
  redirectUrl.searchParams.set("reference", reference)

  let checkout
  try {
    checkout = await payweave.checkout.create({
      amount: DEMO_AMOUNT,
      customer: { email },
      reference,
      redirectUrl: redirectUrl.toString(),
    })
  } catch (error) {
    if (error instanceof PayweaveError) {
      console.error("[payweave] checkout.create failed:", error.toJSON())
      return new Response("Could not start checkout. Please try again.", {
        status: 502,
      })
    }
    throw error
  }

  // Never grant value here — this only sends the customer to Stripe. The
  // callback route re-verifies before the order is treated as paid.
  redirect(checkout.checkoutUrl)
}
