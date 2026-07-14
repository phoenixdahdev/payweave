"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { HugeiconsIcon } from "@hugeicons/react"
import { Sun01Icon, Moon02Icon } from "@hugeicons/core-free-icons"

import { cn } from "@payweave/ui/lib/utils"

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  // Hydration guard for next-themes: the resolved theme is only known on the
  // client, so we render a placeholder until mounted to avoid a mismatch.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  const isDark = resolvedTheme === "dark"

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-md border border-border bg-background/40 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className
      )}
    >
      {mounted ? (
        <HugeiconsIcon
          icon={isDark ? Sun01Icon : Moon02Icon}
          className="size-4"
        />
      ) : (
        <span className="size-4" />
      )}
    </button>
  )
}
