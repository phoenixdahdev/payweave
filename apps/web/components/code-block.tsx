"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"

import { cn } from "@payweave/ui/lib/utils"

type Token = { text: string; kind?: "comment" | "keyword" | "string" | "fn" }

/** Lightweight, dependency-free highlighter for the short TS snippets on the
 * landing page. Full syntax highlighting on /docs is handled by Fumadocs (Shiki). */
function highlight(line: string): React.ReactNode {
  const trimmed = line.trimStart()
  if (trimmed.startsWith("//")) {
    return <span className="text-muted-foreground">{line}</span>
  }

  const tokens: Token[] = []
  const regex =
    /(`[^`]*`|"[^"]*"|'[^']*')|\b(import|from|const|await|new|return|switch|case|break|type|export)\b|([A-Za-z_$][\w$]*)(?=\()/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) tokens.push({ text: line.slice(last, m.index) })
    if (m[1]) tokens.push({ text: m[1], kind: "string" })
    else if (m[2]) tokens.push({ text: m[2], kind: "keyword" })
    else if (m[3]) tokens.push({ text: m[3], kind: "fn" })
    last = m.index + m[0].length
  }
  if (last < line.length) tokens.push({ text: line.slice(last) })

  return tokens.map((t, i) => {
    if (t.kind === "string")
      return (
        <span key={i} className="text-chart-2">
          {t.text}
        </span>
      )
    if (t.kind === "keyword")
      return (
        <span key={i} className="text-thread-teal">
          {t.text}
        </span>
      )
    if (t.kind === "fn")
      return (
        <span key={i} className="text-thread-gold">
          {t.text}
        </span>
      )
    return <span key={i}>{t.text}</span>
  })
}

export function CodeBlock({
  code,
  filename,
  language = "ts",
  className,
}: {
  code: string
  filename?: string
  language?: string
  className?: string
}) {
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = React.useCallback(() => {
    // Guard: navigator.clipboard is undefined in insecure (HTTP) contexts.
    if (typeof navigator === "undefined" || !navigator.clipboard) return
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1600)
    })
  }, [code])

  // Clear a pending reset timer on unmount to avoid a state update on an
  // unmounted component.
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const lines = code.replace(/\n$/, "").split("\n")

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card/60 shadow-2xl shadow-black/20 backdrop-blur",
        className
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-thread-rust/70" />
          <span className="size-2.5 rounded-full bg-thread-gold/70" />
          <span className="size-2.5 rounded-full bg-thread-teal/70" />
          {filename ? (
            <span className="ml-3 font-mono text-xs text-muted-foreground">
              {filename}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            className="size-3.5"
          />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
        <code className={`language-${language} font-mono`}>
          {lines.map((line, i) => (
            <span key={i} className="block min-h-[1.4em]">
              {highlight(line)}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
