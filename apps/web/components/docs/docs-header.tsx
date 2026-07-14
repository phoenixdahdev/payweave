// Adapted from EvilCharts (https://github.com/legions-developer/evilcharts) — MIT
//
// Sticky docs header that sits inside the content panel's top-right notch. Ports
// EvilCharts' sidebar/header.tsx + theme-switcher.tsx: the controls (search,
// theme toggle, GitHub) are grouped on the RIGHT, tucked into the decorative
// notch. Payweave uses its own GitHub URL and drops the personal credit; icons
// are Hugeicons (matching EvilCharts' glyph choices).
"use client"

import * as React from "react"
import Link from "next/link"
import { useTheme } from "next-themes"
import { useSearchContext } from "fumadocs-ui/contexts/search"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Search01Icon,
  Sun03Icon,
  Moon02Icon,
  GithubIcon,
  SidebarLeft01Icon,
} from "@hugeicons/core-free-icons"

const GITHUB_URL = "https://github.com/phoenixdahdev/payweave"

function ThemeSwitcher() {
  const { setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  const toggle = React.useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark")
  }, [resolvedTheme, setTheme])

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      className="text-muted-foreground hover:text-primary hover:bg-accent inline-flex size-7 items-center justify-center rounded-md transition-colors"
    >
      {mounted ? (
        <HugeiconsIcon
          icon={resolvedTheme === "dark" ? Sun03Icon : Moon02Icon}
          size={14}
        />
      ) : (
        <span className="size-3.5" />
      )}
    </button>
  )
}

export function DocsHeader({ onMenu }: { onMenu: () => void }) {
  const search = useSearchContext()

  return (
    <header className="bg-background pointer-events-none sticky top-0 z-30 flex h-14 w-full flex-row items-center justify-between border-b px-3 sidebar:h-[35px] sidebar:border-b-0 sidebar:bg-transparent sidebar:px-0">
      <div className="pointer-events-auto flex items-center sidebar:pl-3">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open navigation"
          className="text-muted-foreground hover:text-primary hover:bg-accent inline-flex size-7 items-center justify-center rounded-md transition-colors sidebar:hidden"
        >
          <HugeiconsIcon icon={SidebarLeft01Icon} size={16} />
        </button>
      </div>

      {/* Controls grouped on the RIGHT, tucked into the notch. */}
      <div className="pointer-events-auto relative z-10 flex h-full items-center gap-1 pr-3">
        <button
          type="button"
          onClick={() => search.setOpenSearch(true)}
          aria-label="Search docs"
          className="text-muted-foreground hover:text-primary bg-muted/40 hover:bg-accent flex h-7 items-center gap-2 rounded-md border px-2 text-xs transition-colors"
        >
          <HugeiconsIcon icon={Search01Icon} size={14} />
          <span className="hidden sm:inline">Search</span>
          <kbd className="bg-background text-muted-foreground/70 hidden rounded border px-1 font-mono text-[10px] sm:inline">
            ⌘K
          </kbd>
        </button>
        <span className="text-muted mx-0.5 select-none">|</span>
        <ThemeSwitcher />
        <span className="text-muted mx-0.5 select-none">|</span>
        <Link
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          aria-label="Payweave on GitHub"
          className="text-muted-foreground hover:text-primary hover:bg-accent inline-flex size-7 items-center justify-center rounded-md transition-colors"
        >
          <HugeiconsIcon icon={GithubIcon} size={14} />
        </Link>
      </div>
    </header>
  )
}
