import { redirect } from "next/navigation"
import { PayweaveError } from "payweave"

import { payweave } from "@/lib/payweave"

/**
 * Stripe/Payweave redirects the customer back here (see `redirectUrl` in
 * `app/api/checkout/route.ts`). We re-verify with Payweave before deciding
 * whether the order was actually paid — the query string alone is never
 * trusted for that.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const reference = searchParams.get("reference")

  if (!reference) {
    redirect("/checkout/failed?status=missing_reference")
  }

  let result
  try {
    result = await payweave.verify({ reference })
  } catch (error) {
    if (error instanceof PayweaveError) {
      console.error("[payweave] verify failed:", error.toJSON())
      redirect("/checkout/failed?status=verification_error")
    }
    throw error
  }

  if (result.status === "success") {
    redirect(`/checkout/success?status=${result.status}`)
  }

  redirect(`/checkout/failed?status=${result.status}`)
}
