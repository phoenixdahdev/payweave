import { cn } from "@payweave/ui/lib/utils"
import Image from "next/image"

/**
 * Payweave "weave" mark — three interlocking strands (one per provider
 * thread: gold, rust, teal), converging into one. Original artwork (not
 * copied from any source).
 */
export function WeaveMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("size-6", className)}
    >
      <path
        d="M2 6c3.5 2 3.5 5 5 6"
        stroke="var(--thread-gold)"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M2 12c3.5 0 3.5 0 5 0"
        stroke="var(--thread-rust)"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M2 18c3.5-2 3.5-5 5-6"
        stroke="var(--thread-teal)"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M7 12c3-2.4 4-2.4 7 0"
        stroke="var(--foreground)"
        strokeWidth="2.1"
        strokeLinecap="round"
        opacity="0.85"
      />
      <circle cx="19" cy="12" r="2.6" fill="var(--foreground)" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Image src="/logo.png" alt="Payweave" width={24} height={24} />
      <span className="font-display text-[16px] font-semibold tracking-tight">
        Payweave
      </span>
    </span>
  )
}
