import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import { Github01Icon } from "@hugeicons/core-free-icons"

import { Wordmark } from "@/components/brand"

const GITHUB_URL = "https://github.com/phoenixdahdev/payweave"

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "Providers", href: "/#providers" },
      { label: "Webhooks", href: "/docs/webhooks" },
    ],
  },
  {
    title: "SDK",
    links: [
      { label: "Unified layer", href: "/docs/unified-layer" },
      { label: "Errors & retries", href: "/docs/errors-and-retries" },
      { label: "npm: payweave", href: "https://www.npmjs.com/package/payweave" },
      { label: "GitHub", href: GITHUB_URL },
    ],
  },
]

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-sidebar/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-xs">
            <Wordmark />
            <p className="mt-4 text-sm text-muted-foreground">
              One SDK, every provider — woven together. The unified, fully-typed
              TypeScript SDK for Paystack and Flutterwave.
            </p>
            <Link
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-5 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <HugeiconsIcon icon={Github01Icon} className="size-4" />
              phoenixdahdev/payweave
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-10 sm:gap-16">
            {COLUMNS.map((col) => (
              <div key={col.title}>
                <h3 className="text-sm font-semibold text-foreground">
                  {col.title}
                </h3>
                <ul className="mt-4 space-y-3">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-2 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Payweave · MIT License</p>
          <p>
            Design system adapted from{" "}
            <Link
              href="https://github.com/legions-developer/evilcharts"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted underline-offset-4 hover:text-foreground"
            >
              EvilCharts
            </Link>{" "}
            (MIT). Icons by Hugeicons.
          </p>
        </div>
      </div>
    </footer>
  )
}
