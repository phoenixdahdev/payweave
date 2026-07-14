import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import type { IconSvgElement } from "@hugeicons/react"
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Github01Icon,
  ConnectIcon,
  PuzzleIcon,
  Exchange01Icon,
  WebhookIcon,
  DashboardSquare01Icon,
  AlertCircleIcon,
  Package01Icon,
  SparklesIcon,
  SecurityCheckIcon,
  Refresh01Icon,
  Tick02Icon,
  CheckmarkBadge01Icon,
  BookOpen01Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@payweave/ui/components/button"

import { cn } from "@payweave/ui/lib/utils"
import { SiteNav } from "@/components/site-nav"
import { SiteFooter } from "@/components/site-footer"
import { CodeBlock } from "@/components/code-block"

const GITHUB_URL = "https://github.com/phoenixdahdev/payweave"

const HERO_SNIPPET = `import { createPaystack } from "payweave"

const sdk = createPaystack({ secretKey: process.env.PAYSTACK_SECRET_KEY! })

// One unified call — always minor units; the adapter converts.
const checkout = await sdk.unified.checkout.create({
  amount: { value: 500_000, currency: "NGN" },
  customer: { email: "ada@example.com" },
  reference: "order_8123",
  redirectUrl: "https://app.example.com/pay/callback",
})

console.log(checkout.checkoutUrl)`

const SURFACE_A_SNIPPET = `// Surface A — every provider endpoint, 1:1 and fully typed.
const tx = await paystack.paystack.transactions.initialize({
  email: "ada@example.com",
  amount: 500_000, // kobo
  currency: "NGN",
})

// The provider is narrowed at compile time:
// paystack.flutterwave  ->  property does not exist`

const WEBHOOK_SNIPPET = `// Verify on the exact raw bytes — never parse-then-re-stringify.
app.post("/webhooks", express.raw({ type: "*/*" }), (req, res) => {
  const event = sdk.webhooks.constructEvent({
    rawBody: req.body,
    headers: req.headers,
  })

  res.sendStatus(200) // ack fast, process async

  switch (event.unifiedType) {
    case "payment.succeeded":
      // re-verify before granting value
      break
  }
})`

type Feature = {
  icon: IconSvgElement
  title: string
  body: string
}

const FEATURES: Feature[] = [
  {
    icon: ConnectIcon,
    title: "One import, any provider",
    body: "Initialize with a provider and get a fully-typed client exposing every endpoint that provider supports — no hand-rolled fetch calls.",
  },
  {
    icon: PuzzleIcon,
    title: "Compile-time provider narrowing",
    body: "A Flutterwave client has no .paystack property, and vice-versa. Autocomplete only ever shows the provider you configured.",
  },
  {
    icon: Exchange01Icon,
    title: "Full test / live parity",
    body: "Both environments work out of the box, inferred from your key prefix. Going live is a config change, not a code change.",
  },
  {
    icon: WebhookIcon,
    title: "Webhooks, done correctly",
    body: "One handler verifies signatures per provider — raw bytes, constant-time comparison, fail-closed — then returns a typed, normalized event.",
  },
  {
    icon: DashboardSquare01Icon,
    title: "A unified layer, no lock-in",
    body: "Normalized checkout, verify, refunds, transfers and banks across providers. Every response still carries the untouched raw payload.",
  },
  {
    icon: AlertCircleIcon,
    title: "Errors that name the culprit",
    body: "Typed subclasses tell you whether a failure is yours (validation/auth), the customer's (declined), or transient (network/5xx).",
  },
  {
    icon: Package01Icon,
    title: "Tiny, modern footprint",
    body: "ESM-only, with zod as the only runtime dependency and Node >= 20.19. Every subpath export is independently tree-shakeable.",
  },
  {
    icon: SecurityCheckIcon,
    title: "Money that can't drift",
    body: "Always integer minor units in the unified layer; the adapters convert kobo and naira so you never fat-finger a decimal.",
  },
]

const AUDIENCE = [
  {
    title: "First-time integrators",
    body: "Accept a payment without reading raw REST docs — initialize one SDK with your provider and secret key.",
  },
  {
    title: "Multi-provider teams",
    body: "Add a second provider for redundancy behind one normalized layer, so your business logic never branches on provider.",
  },
  {
    title: "Agencies & freelancers",
    body: "Ship many client integrations against one mental model, with the same webhook handling every time.",
  },
  {
    title: "AI coding agents",
    body: "Generate integration code against a well-typed, well-documented surface with predictable, discoverable APIs.",
  },
]

type Provider = {
  name: string
  status: string
  shipped: boolean
  body: string
}

const PROVIDERS: Provider[] = [
  {
    name: "Paystack",
    status: "P0 · shipped",
    shipped: true,
    body: "Transactions, refunds, customers, transfers, verification, plans & subscriptions — typed 1:1 from the official API.",
  },
  {
    name: "Flutterwave v3",
    status: "P0 · shipped",
    shipped: true,
    body: "Payments, transactions, refunds, transfers, banks and charges (incl. 3DES card encryption) on the default v3 surface.",
  },
  {
    name: "Flutterwave v4",
    status: "In progress",
    shipped: false,
    body: "OAuth client-credentials auth and the webhook verifier are in place; the resource surface is landing next.",
  },
  {
    name: "Framework adapters",
    status: "In progress",
    shipped: false,
    body: "Drop-in webhook handlers for Express, Next.js and Fastify that capture the raw body and verify for you.",
  },
]

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-3 py-1 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  )
}

export default function Page() {
  return (
    <>
      <SiteNav />
      <main className="flex-1">
        {/* Hero — tagline + §1 problem statement */}
        <section className="relative overflow-hidden">
          <div className="bg-grid pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
          <div
            className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full opacity-40 blur-3xl"
            style={{
              background:
                "radial-gradient(circle at center, var(--brand), transparent 60%)",
            }}
          />
          <div className="relative mx-auto grid w-full max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:py-28">
            <div>
              <SectionLabel>
                <HugeiconsIcon icon={SparklesIcon} className="size-3.5" />
                Pre-release · Paystack + Flutterwave
              </SectionLabel>
              <h1 className="font-heading mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
                One SDK, every provider —{" "}
                <span className="bg-gradient-to-r from-brand to-brand-2 bg-clip-text text-transparent">
                  woven together.
                </span>
              </h1>
              <p className="mt-6 max-w-xl text-base text-muted-foreground text-pretty sm:text-lg">
                Paystack and Flutterwave dominate payments across Africa, yet
                neither ships an official, maintained server-side TypeScript SDK.
                Developers hand-roll{" "}
                <code className="text-foreground">fetch</code> calls, copy-paste
                webhook verification (and get it wrong), then duplicate all of it
                for a second provider. Payweave is the one open-source SDK that
                fixes that.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button size="lg" nativeButton={false} render={<Link href="/docs" />}>
                  Get started
                  <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" />
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  nativeButton={false}
                  render={
                    <Link href={GITHUB_URL} target="_blank" rel="noreferrer" />
                  }
                >
                  <HugeiconsIcon icon={Github01Icon} className="size-4" />
                  GitHub
                </Button>
              </div>

              <div className="mt-6 inline-flex items-center gap-3 rounded-lg border border-border bg-card/50 px-4 py-2.5 font-mono text-sm">
                <span className="text-muted-foreground select-none">$</span>
                <span>npm install payweave</span>
              </div>
            </div>

            <CodeBlock filename="checkout.ts" code={HERO_SNIPPET} />
          </div>
        </section>

        {/* Features — §2 Goals + §6 Product Design */}
        <section
          id="features"
          className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6"
        >
          <div className="max-w-2xl">
            <SectionLabel>What you get</SectionLabel>
            <h2 className="font-heading mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
              The de-facto official SDK for two providers
            </h2>
            <p className="mt-4 text-muted-foreground">
              Full endpoint coverage for each provider, fully typed, with
              first-class webhook verification and a normalized layer when you
              want portability.
            </p>
          </div>

          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="group bg-card/60 p-6 transition-colors hover:bg-card"
              >
                <div className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-background text-brand transition-colors group-hover:text-brand-2">
                  <HugeiconsIcon icon={feature.icon} className="size-5" />
                </div>
                <h3 className="mt-4 text-base font-semibold">{feature.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Code showcase — Surface A + webhooks (README) */}
        <section className="border-y border-border bg-sidebar/40">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center">
            <div>
              <SectionLabel>Two surfaces, no compromise</SectionLabel>
              <h2 className="font-heading mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
                Provider-native when you need control. Unified when you want
                portability.
              </h2>
              <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
                {[
                  "Surface A exposes every endpoint 1:1 with the provider's own field names.",
                  "Surface B normalizes the high-traffic operations across providers.",
                  "Every response carries raw, so the abstraction never traps you.",
                ].map((point) => (
                  <li key={point} className="flex items-start gap-3">
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      className="mt-0.5 size-4 shrink-0 text-brand"
                    />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-4">
              <CodeBlock filename="surface-a.ts" code={SURFACE_A_SNIPPET} />
              <CodeBlock filename="webhook.ts" code={WEBHOOK_SNIPPET} />
            </div>
          </div>
        </section>

        {/* Providers — status */}
        <section
          id="providers"
          className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6"
        >
          <div className="max-w-2xl">
            <SectionLabel>Coverage</SectionLabel>
            <h2 className="font-heading mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
              Shipping now, expanding fast
            </h2>
            <p className="mt-4 text-muted-foreground">
              Paystack, Flutterwave v3, webhooks and the unified layer are
              implemented and tested. Flutterwave v4 and the framework adapters
              are in progress.
            </p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {PROVIDERS.map((provider) => (
              <div
                key={provider.name}
                className="rounded-2xl border border-border bg-card/60 p-6"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-lg font-semibold">{provider.name}</h3>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                      provider.shipped
                        ? "bg-brand/10 text-brand"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    <HugeiconsIcon
                      icon={
                        provider.shipped ? CheckmarkBadge01Icon : Refresh01Icon
                      }
                      className="size-3.5"
                    />
                    {provider.status}
                  </span>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  {provider.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Who it's for — §5 user stories */}
        <section className="border-y border-border bg-sidebar/40">
          <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
            <div className="max-w-2xl">
              <SectionLabel>Who it&apos;s for</SectionLabel>
              <h2 className="font-heading mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
                Built for everyone shipping African payments
              </h2>
            </div>
            <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {AUDIENCE.map((persona) => (
                <div
                  key={persona.title}
                  className="rounded-2xl border border-border bg-card/60 p-6"
                >
                  <h3 className="text-base font-semibold">{persona.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {persona.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6">
          <div className="relative overflow-hidden rounded-3xl border border-border bg-card/60 px-6 py-16 text-center sm:px-16">
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-40 blur-3xl"
              style={{
                background:
                  "radial-gradient(ellipse at top, var(--brand-2), transparent 70%)",
              }}
            />
            <h2 className="font-heading relative text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Ship your first verified payment in under 10 minutes
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-muted-foreground">
              Install once, initialize with your provider, and go from a checkout
              URL to a verified payment to a handled webhook.
            </p>
            <div className="relative mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" nativeButton={false} render={<Link href="/docs" />}>
                <HugeiconsIcon icon={BookOpen01Icon} className="size-4" />
                Read the docs
              </Button>
              <Button
                size="lg"
                variant="outline"
                nativeButton={false}
                render={
                  <Link href={GITHUB_URL} target="_blank" rel="noreferrer" />
                }
              >
                Star on GitHub
                <HugeiconsIcon icon={ArrowUpRight01Icon} className="size-4" />
              </Button>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  )
}
