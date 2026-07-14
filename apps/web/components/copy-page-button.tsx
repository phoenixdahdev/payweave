// Adapted from EvilCharts (https://github.com/legions-developer/evilcharts) — MIT
//
// Ported from src/components/docs/layout/docs-copy-button.tsx: a split "Copy
// Page" control — a primary button that copies the page's raw Markdown to the
// clipboard, plus a caret that opens a dropdown ("View as Markdown", "Open in
// ChatGPT", "Open in Claude"). The dropdown is a small self-contained menu
// (React state + outside-click / Escape close). Icons are Hugeicons. No backend
// or data submission; the AI links just prefill a prompt.
"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Copy01Icon,
  Tick02Icon,
  ArrowDown01Icon,
  File01Icon,
  LinkSquare02Icon,
} from "@hugeicons/core-free-icons"

import { cn } from "@payweave/ui/lib/utils"

function buildPromptUrl(base: string, pageUrl: string) {
  return `${base}?q=${encodeURIComponent(
    `I'm looking at this Payweave documentation page: ${pageUrl}. Help me understand how to use it — be ready to explain concepts, give examples, or help debug based on it.`
  )}`
}

export function CopyPageButton({
  markdown,
  url,
  className,
}: {
  markdown: string
  url?: string
  className?: string
}) {
  const [copied, setCopied] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const timeout = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    return () => {
      if (timeout.current) clearTimeout(timeout.current)
    }
  }, [])

  // Close the dropdown on outside click / Escape.
  React.useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      if (timeout.current) clearTimeout(timeout.current)
      timeout.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be unavailable (insecure context / denied permission);
      // fail silently rather than throwing in the user's face.
    }
  }

  function openPrompt(base: string) {
    setOpen(false)
    const absolute = url
      ? new URL(url, window.location.origin).toString()
      : window.location.href
    window.open(
      buildPromptUrl(base, absolute),
      "_blank",
      "noopener,noreferrer"
    )
  }

  function viewAsMarkdown() {
    setOpen(false)
    try {
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" })
      const objectUrl = URL.createObjectURL(blob)
      window.open(objectUrl, "_blank", "noopener,noreferrer")
      // Revoke shortly after the new tab has had a chance to load it.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
    } catch {
      // Ignore — pop-up blocked or Blob unsupported.
    }
  }

  const menuItemClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground/80 hover:bg-muted/50 hover:text-primary transition-colors"

  return (
    <div
      ref={rootRef}
      className={cn(
        "dark:bg-primary-foreground group/buttons relative flex rounded-lg bg-[#F5F5F5] p-[2px] select-none",
        className
      )}
    >
      <button
        type="button"
        aria-label="Copy page as Markdown"
        onClick={onCopy}
        className="bg-background hover:border-primary/20 text-muted-foreground hover:text-primary relative flex h-7 items-center gap-1.5 rounded-md rounded-r-none border border-r-0 px-1.5 text-xs font-medium transition-colors"
      >
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          size={14}
          aria-hidden
        />
        <span className={cn(copied && "opacity-0")}>Copy Page</span>
        <span
          className={cn(
            "absolute right-1.5 opacity-0",
            copied && "opacity-100"
          )}
        >
          Copied
        </span>
      </button>
      <button
        type="button"
        aria-label="Open dropdown menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="bg-background hover:border-primary/20 text-muted-foreground hover:text-primary flex h-7 items-center rounded-md rounded-l-none border px-1 text-xs transition-colors"
      >
        <HugeiconsIcon icon={ArrowDown01Icon} size={14} aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          className="bg-background absolute top-full right-0 z-50 mt-1 min-w-52 rounded-lg border p-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={viewAsMarkdown}
            className={menuItemClass}
          >
            <HugeiconsIcon icon={File01Icon} size={16} aria-hidden />
            View as Markdown
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => openPrompt("https://chatgpt.com")}
            className={menuItemClass}
          >
            <HugeiconsIcon icon={LinkSquare02Icon} size={16} aria-hidden />
            Open in ChatGPT
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => openPrompt("https://claude.ai/new")}
            className={menuItemClass}
          >
            <HugeiconsIcon icon={LinkSquare02Icon} size={16} aria-hidden />
            Open in Claude
          </button>
        </div>
      ) : null}
    </div>
  )
}
