import { cn } from "@payweave/ui/lib/utils"

/**
 * Payweave "weave" mark — two interlocking strands, rendered in the brand
 * indigo→violet gradient. Original artwork (not copied from any source).
 */
export function WeaveMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("size-6", className)}
    >
      <defs>
        <linearGradient id="pw-weave" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--brand-2)" />
        </linearGradient>
      </defs>
      <path
        d="M3 8c4.5 0 4.5 8 9 8s4.5-8 9-8"
        stroke="url(#pw-weave)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M3 16c4.5 0 4.5-8 9-8s4.5 8 9 8"
        stroke="url(#pw-weave)"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <WeaveMark />
      <span className="font-heading text-[15px] font-semibold tracking-tight">
        Payweave
      </span>
    </span>
  )
}
