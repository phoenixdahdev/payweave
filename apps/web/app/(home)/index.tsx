"use client"

import Link from "next/link"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import type { IconSvgElement } from "@hugeicons/react"
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Github01Icon,
  PuzzleIcon,
  WebhookIcon,
  AlertCircleIcon,
  SecurityCheckIcon,
  Tick02Icon,
  CheckmarkBadge01Icon,
  Refresh01Icon,
  BookOpen01Icon,
  DatabaseIcon,
  Wallet01Icon,
  ChartIncreaseIcon,
  TerminalIcon,
  ConnectIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@payweave/ui/components/button"

import { cn } from "@payweave/ui/lib/utils"
import { CodeBlock } from "@/components/code-block"
import { WeaveSignature } from "@/components/weave-signature"
import { useReducedMotion } from "@/lib/use-reduced-motion"

const GITHUB_URL = "https://github.com/phoenixdahdev/payweave"

const HERO_SNIPPET = `import { createPayweave } from "payweave"

const payweave = createPayweave({
  paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY! },
})

// One unified call — always minor units; the adapter converts.
const checkout = await payweave.checkout.create({
  amount: { value: 500_000, currency: "NGN" },
  customer: { email: "ada@example.com" },
  reference: "order_8123",
  redirectUrl: "https://app.example.com/pay/callback",
})

console.log(checkout.checkoutUrl)`

const SURFACE_A_SNIPPET = `// Surface A — every provider endpoint, 1:1 and fully typed.
const tx = await payweave.paystack.transactions.initialize({
  email: "ada@example.com",
  amount: 500_000, // kobo
  currency: "NGN",
})

// The provider is narrowed at compile time:
// payweave.flutterwave  ->  not configured on this client`

const WEBHOOK_SNIPPET = `// One endpoint verifies every configured provider — the header says which.
app.post("/webhooks", express.raw({ type: "*/*" }), (req, res) => {
  const event = payweave.webhooks.constructEvent({
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
    title: "One client, every provider",
    body: "Configure one or more of Stripe, Paystack, and Flutterwave under createPayweave and get a single, fully-typed client — no hand-rolled fetch calls.",
  },
  {
    icon: PuzzleIcon,
    title: "Compile-time provider narrowing",
    body: "Only configured providers appear on the client. Autocomplete never shows a namespace you didn't set up.",
  },
  {
    icon: WebhookIcon,
    title: "Webhooks, done correctly",
    body: "One endpoint verifies every configured provider — raw bytes, constant-time comparison, fail-closed — then returns a typed, normalized event.",
  },
  {
    icon: SecurityCheckIcon,
    title: "A capability-gated unified layer",
    body: "Checkout, verify, refunds, transfers and banks, normalized across providers — gated by a capability matrix, so an unsupported call fails before it's sent, not after.",
  },
  {
    icon: AlertCircleIcon,
    title: "Errors that name the culprit",
    body: "Typed subclasses tell you whether a failure is yours (validation/auth), the customer's (declined), or transient (network/5xx).",
  },
  {
    icon: Tick02Icon,
    title: "Money that can't drift",
    body: "Always integer minor units in the unified layer; the adapters convert kobo, naira, and cents so you never fat-finger a decimal.",
  },
]

type PlatformItem = {
  icon: IconSvgElement
  title: string
  body: string
  href: string
}

const PLATFORM: PlatformItem[] = [
  {
    icon: DatabaseIcon,
    title: "A database layer",
    body: "Bring your own adapter — sqlite, Postgres, MongoDB, or Drizzle today — and persist customers, subscriptions, and usage.",
    href: "/docs/database",
  },
  {
    icon: Wallet01Icon,
    title: "Plans & features",
    body: "Define plan() and feature() once; push them to your billing providers and subscribe customers with subscribe().",
    href: "/docs/plans-and-features",
  },
  {
    icon: ChartIncreaseIcon,
    title: "Metered usage",
    body: "Gate and record usage against a limit with check() and report() — automatic period resets, no cron job required.",
    href: "/docs/metered-usage",
  },
  {
    icon: TerminalIcon,
    title: "A CLI that ships with it",
    body: "payweave init · push · listen · status — scaffold a project, migrate and sync plans, relay webhooks locally, validate your setup.",
    href: "/docs/cli",
  },
]

const AUDIENCE = [
  {
    title: "First-time integrators",
    body: "Accept a payment without reading raw REST docs — initialize one client with a provider and a secret key.",
  },
  {
    title: "Multi-provider teams",
    body: "Add a second provider for redundancy or reach behind one normalized layer, so your business logic never branches on provider.",
  },
  {
    title: "Teams that bill on usage",
    body: "Plans, features, and metered usage backed by your own database — not a separate billing service to keep in sync.",
  },
  {
    title: "AI coding agents",
    body: "Generate integration code against a well-typed, well-documented surface with predictable, discoverable APIs.",
  },
]

type Thread = {
  name: string
  colorVar: string
  colorClass: string
  status: string
  shipped: boolean
  body: string
}

const THREADS: Thread[] = [
  {
    name: "Stripe",
    colorVar: "var(--thread-gold)",
    colorClass: "text-thread-gold",
    status: "Shipped",
    shipped: true,
    body: "Checkout Sessions, Payment Intents, customers, products & prices, subscriptions, refunds — typed 1:1 from the official API.",
  },
  {
    name: "Paystack",
    colorVar: "var(--thread-rust)",
    colorClass: "text-thread-rust",
    status: "Shipped",
    shipped: true,
    body: "Transactions, refunds, customers, transfers, plans & subscriptions, account verification — typed 1:1 from the official API.",
  },
  {
    name: "Flutterwave",
    colorVar: "var(--thread-teal)",
    colorClass: "text-thread-teal",
    status: "v3 shipped · v4 in progress",
    shipped: true,
    body: "v3 ships payments, transactions, refunds, transfers, banks, and charges. v4's OAuth auth and webhook verifier are in place; its resource surface is next.",
  },
]

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="border-border bg-card/50 text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs font-medium tracking-wide uppercase">
      {children}
    </span>
  )
}

function ThreadRule({ className }: { className?: string }) {
  return <div className={cn("thread-rule", className)} />
}

/** Fade-up reveal, once, on scroll into view. Falls back to a plain
 * appearance for reduced-motion — never gates content behind motion. */
function Reveal({
  children,
  delay = 0,
  hover = false,
  className,
}: {
  children: React.ReactNode
  delay?: number
  hover?: boolean
  className?: string
}) {
  const reducedMotion = useReducedMotion()
  return (
    <motion.div
      className={className}
      initial={reducedMotion ? false : { opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      whileHover={hover && !reducedMotion ? { y: -4 } : undefined}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

export default function HomePage() {
  const reducedMotion = useReducedMotion()

  return (
    <main className="flex-1">
      {/* Hero — the weave is the thesis: three provider threads, one client. */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-70 [mask-image:linear-gradient(to_bottom,black,transparent)]"
          style={{
            background:
              "radial-gradient(ellipse 900px 400px at 50% -10%, color-mix(in oklch, var(--thread-gold) 14%, transparent), transparent 70%)",
          }}
        />
        <div className="relative mx-auto w-full max-w-5xl px-4 pt-16 sm:px-6 sm:pt-20">
          <WeaveSignature className="mx-auto max-w-3xl" />
        </div>

        <motion.div
          initial={reducedMotion ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
          className="relative mx-auto w-full max-w-3xl px-4 pt-6 pb-16 text-center sm:px-6 sm:pb-24"
        >
          <SectionLabel>Open source · payweave@0.1.0 · MIT</SectionLabel>
          <h1 className="font-heading mt-7 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
            One SDK. Every provider.{" "}
            <span className="from-thread-gold via-thread-rust to-thread-teal bg-gradient-to-r bg-clip-text text-transparent">
              Woven together.
            </span>
          </h1>
          <p className="text-muted-foreground mx-auto mt-6 max-w-xl text-base text-pretty sm:text-lg">
            Stripe, Paystack, and Flutterwave behind one typed client — with
            subscriptions, metered usage, a database layer, and a CLI built in,
            not bolted on.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
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

          <div className="border-border bg-card/50 mx-auto mt-6 inline-flex items-center gap-3 rounded-lg border px-4 py-2.5 font-mono text-sm">
            <span className="text-muted-foreground select-none">$</span>
            <span>npm install payweave</span>
          </div>
        </motion.div>

        <motion.div
          initial={reducedMotion ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.32, ease: [0.22, 1, 0.36, 1] }}
          className="relative mx-auto w-full max-w-3xl px-4 pb-20 sm:px-6 sm:pb-28"
        >
          <CodeBlock filename="checkout.ts" code={HERO_SNIPPET} />
        </motion.div>
      </section>

      <ThreadRule className="mx-auto max-w-6xl" />

      {/* The problem this collapses */}
      <section className="mx-auto w-full max-w-5xl px-4 py-20 sm:px-6">
        <Reveal className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div className="min-w-0">
            <SectionLabel>The problem</SectionLabel>
            <h2 className="font-heading mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
              Wiring up payments usually means doing it three times.
            </h2>
          </div>
          <ul className="text-muted-foreground min-w-0 space-y-4 text-base">
            {[
              "Hand-rolling fetch calls against each provider's own REST docs, one provider at a time.",
              "Copy-pasting webhook verification snippets — and frequently getting signature validation wrong.",
              "Writing your own subscription/plan bookkeeping and database schema by hand.",
              "Doing it all again the moment you add a second provider, a database, or usage-based billing.",
            ].map((point) => (
              <li key={point} className="flex items-start gap-3">
                <span className="bg-muted-foreground/40 mt-2.5 size-1.5 shrink-0 rounded-full" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </section>

      {/* The three threads */}
      <section
        id="threads"
        className="border-border bg-sidebar/40 scroll-mt-20 border-y"
      >
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
          <Reveal className="max-w-2xl">
            <SectionLabel>Three threads, one client</SectionLabel>
            <h2 className="font-heading mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
              Shipping now, expanding fast
            </h2>
            <p className="text-muted-foreground mt-4">
              Stripe, Paystack, and Flutterwave v3 — provider-native resources,
              webhooks, and the unified layer — are implemented and tested.
              Flutterwave v4&apos;s resource surface is next.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-4 sm:grid-cols-3">
            {THREADS.map((thread, i) => (
              <Reveal key={thread.name} delay={i * 0.08} hover>
                <div className="border-border bg-card/60 relative h-full overflow-hidden rounded-2xl border p-6">
                  <div
                    className="absolute inset-x-0 top-0 h-1"
                    style={{ backgroundColor: thread.colorVar }}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold">{thread.name}</h3>
                    <span className="bg-muted text-muted-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium">
                      <HugeiconsIcon
                        icon={
                          thread.shipped ? CheckmarkBadge01Icon : Refresh01Icon
                        }
                        className={cn("size-3.5", thread.colorClass)}
                      />
                      {thread.status}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-3 text-sm">
                    {thread.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Features grid */}
      <section
        id="features"
        className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6"
      >
        <Reveal className="max-w-2xl">
          <SectionLabel>What you get</SectionLabel>
          <h2 className="font-heading mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
            The SDK fundamentals, done once, done right
          </h2>
          <p className="text-muted-foreground mt-4">
            Full endpoint coverage per provider, fully typed, with first-class
            webhook verification and a normalized layer when you want
            portability.
          </p>
        </Reveal>

        <div className="border-border bg-border mt-12 grid gap-px overflow-hidden rounded-2xl border sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <Reveal key={feature.title} delay={i * 0.05}>
              <div className="group bg-card/60 hover:bg-card h-full p-6 transition-colors">
                <div className="border-border bg-background inline-flex size-10 items-center justify-center rounded-lg border text-thread-gold transition-colors group-hover:text-thread-rust">
                  <HugeiconsIcon icon={feature.icon} className="size-5" />
                </div>
                <h3 className="mt-4 text-base font-semibold">{feature.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm">
                  {feature.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Code showcase — two surfaces */}
      <section className="border-border bg-sidebar/40 border-y">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center">
          <Reveal className="min-w-0">
            <SectionLabel>Two surfaces, no compromise</SectionLabel>
            <h2 className="font-heading mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
              Provider-native when you need control. Unified when you want
              portability.
            </h2>
            <ul className="text-muted-foreground mt-6 space-y-3 text-sm">
              {[
                "Surface A exposes every endpoint 1:1 with the provider's own field names.",
                "Surface B normalizes the high-traffic operations across providers that support them.",
                "Every response carries raw, so the abstraction never traps you.",
              ].map((point) => (
                <li key={point} className="flex items-start gap-3">
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    className="text-thread-teal mt-0.5 size-4 shrink-0"
                  />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={0.1} className="flex min-w-0 flex-col gap-4">
            <CodeBlock filename="surface-a.ts" code={SURFACE_A_SNIPPET} />
            <CodeBlock filename="webhook.ts" code={WEBHOOK_SNIPPET} />
          </Reveal>
        </div>
      </section>

      {/* Beyond payments — the v1 pivot: DB, plans, metered usage, CLI */}
      <section
        id="platform"
        className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6"
      >
        <Reveal className="max-w-2xl">
          <SectionLabel>Beyond payments</SectionLabel>
          <h2 className="font-heading mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
            A billing platform, not just an API client
          </h2>
          <p className="text-muted-foreground mt-4">
            Persist state, define pricing, meter usage, and manage it all from
            a CLI — without reaching for a separate billing service.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLATFORM.map((item, i) => (
            <Reveal key={item.title} delay={i * 0.06} hover>
              <Link
                href={item.href}
                className="border-border bg-card/60 hover:bg-card group block h-full rounded-2xl border p-6 transition-colors"
              >
                <div className="border-border bg-background text-thread-teal inline-flex size-10 items-center justify-center rounded-lg border">
                  <HugeiconsIcon icon={item.icon} className="size-5" />
                </div>
                <h3 className="mt-4 flex items-center gap-1.5 text-base font-semibold">
                  {item.title}
                  <HugeiconsIcon
                    icon={ArrowUpRight01Icon}
                    className="text-muted-foreground size-3.5 opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </h3>
                <p className="text-muted-foreground mt-2 text-sm">
                  {item.body}
                </p>
              </Link>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Audience */}
      <section className="border-border bg-sidebar/40 border-y">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
          <Reveal className="max-w-2xl">
            <SectionLabel>Who it&apos;s for</SectionLabel>
            <h2 className="font-heading mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
              Built for everyone shipping payments
            </h2>
          </Reveal>
          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {AUDIENCE.map((persona, i) => (
              <Reveal key={persona.title} delay={i * 0.05}>
                <div className="border-border bg-card/60 h-full rounded-2xl border p-6">
                  <h3 className="text-base font-semibold">{persona.title}</h3>
                  <p className="text-muted-foreground mt-2 text-sm">
                    {persona.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6">
        <Reveal className="border-border bg-card/60 relative overflow-hidden rounded-3xl border px-6 py-16 text-center sm:px-16">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-50 blur-3xl"
            style={{
              background:
                "linear-gradient(90deg, color-mix(in oklch, var(--thread-gold) 40%, transparent), color-mix(in oklch, var(--thread-rust) 40%, transparent), color-mix(in oklch, var(--thread-teal) 40%, transparent))",
            }}
          />
          <h2 className="font-heading relative text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Ship your first verified payment in under 10 minutes
          </h2>
          <p className="text-muted-foreground relative mx-auto mt-4 max-w-xl">
            Install once, configure a provider, and go from a checkout URL to
            a verified payment to a handled webhook.
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
        </Reveal>
      </section>
    </main>
  )
}
