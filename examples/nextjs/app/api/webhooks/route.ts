import { payweave } from "@/lib/payweave"

export async function POST(req: Request) {
  const rawBody = await req.text()
  const headers = Object.fromEntries(req.headers)

  let event
  try {
    event = payweave.webhooks.constructEvent({ rawBody, headers })
  } catch {
    // A bad/missing signature throws PayweaveWebhookVerificationError.
    return new Response("bad signature", { status: 400 })
  }

  // Ack fast, then handle:
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

  return new Response("ok", { status: 200 })
}
