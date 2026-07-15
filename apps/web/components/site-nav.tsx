"use client"

import * as React from "react"
import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Github01Icon,
  Menu01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@payweave/ui/components/button"

import { cn } from "@payweave/ui/lib/utils"
import { Wordmark } from "@/components/brand"
import { ThemeToggle } from "@/components/theme-toggle"

const GITHUB_URL = "https://github.com/phoenixdahdev/payweave"

const NAV_LINKS = [
  { label: "Docs", href: "/docs" },
  { label: "Providers", href: "/#threads" },
  { label: "Features", href: "/#features" },
]

export function SiteNav() {
  const [open, setOpen] = React.useState(false)

  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="shrink-0">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Payweave on GitHub"
            className="hidden size-9 items-center justify-center rounded-md border border-border bg-background/40 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:inline-flex"
          >
            <HugeiconsIcon icon={Github01Icon} className="size-4" />
          </Link>
          <ThemeToggle />
          <Button
            nativeButton={false}
            render={<Link href="/docs" />}
            className="hidden sm:inline-flex"
          >
            Get started
            <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" />
          </Button>
          <button
            type="button"
            aria-label="Toggle menu"
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground md:hidden"
          >
            <HugeiconsIcon icon={Menu01Icon} className="size-4" />
          </button>
        </div>
      </div>

      <div
        id="mobile-menu"
        className={cn(
          "border-t border-border/70 md:hidden",
          open ? "block" : "hidden"
        )}
      >
        <nav className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-3">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            GitHub
          </Link>
        </nav>
      </div>
    </header>
  )
}
