import { cn } from "@payweave/ui/lib/utils"

function smoothstep(x: number, edge0: number, edge1: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

type ThreadSpec = {
  startY: number
  phase: number
}

/**
 * Builds one thread's path: parallel and separate on the left (one lane per
 * provider), interlacing through a middle "weave" zone, settling toward a
 * shared centerline on the right — the tagline ("one SDK, every provider,
 * woven together") as geometry rather than decoration.
 */
function threadPath(
  spec: ThreadSpec,
  { width, midY, amplitude, wavelengths }: { width: number; midY: number; amplitude: number; wavelengths: number }
): string {
  const CONVERGE_START = 0.14
  const CONVERGE_END = 0.46
  const SETTLE_START = 0.8
  const SETTLE_END = 0.97
  const samples = 90
  const pts: [number, number][] = []

  for (let i = 0; i <= samples; i++) {
    const f = i / samples
    const x = f * width
    const converge = smoothstep(f, CONVERGE_START, CONVERGE_END)
    const baseline = lerp(spec.startY, midY, converge)
    const envelope = converge * (1 - smoothstep(f, SETTLE_START, SETTLE_END) * 0.82)
    const t = f * wavelengths * Math.PI * 2 + spec.phase
    const y = baseline + Math.sin(t) * amplitude * envelope
    pts.push([x, y])
  }

  const [firstX, firstY] = pts[0] ?? [0, 0]
  let d = `M ${firstX.toFixed(2)},${firstY.toFixed(2)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i] ?? [0, 0]
    const [x1, y1] = pts[i + 1] ?? [0, 0]
    const mx = (x0 + x1) / 2
    const my = (y0 + y1) / 2
    d += ` Q ${x0.toFixed(2)},${y0.toFixed(2)} ${mx.toFixed(2)},${my.toFixed(2)}`
  }
  const [lastX, lastY] = pts[pts.length - 1] ?? [0, 0]
  d += ` L ${lastX.toFixed(2)},${lastY.toFixed(2)}`
  return d
}

const WIDTH = 1200
const HEIGHT = 240
const MID_Y = 120
/** Comfortably exceeds any thread's real geometric length at this scale — the
 * draw-in only needs to fully reveal the line, not match it exactly. */
const DASH_LENGTH = 2000

const THREADS = [
  { label: "STRIPE", color: "var(--thread-gold)", spec: { startY: 44, phase: 0 } },
  { label: "PAYSTACK", color: "var(--thread-rust)", spec: { startY: 120, phase: (2 * Math.PI) / 3 } },
  { label: "FLUTTERWAVE", color: "var(--thread-teal)", spec: { startY: 196, phase: (4 * Math.PI) / 3 } },
] as const

export function WeaveSignature({ className }: { className?: string }) {
  const paths = THREADS.map((thread) => ({
    ...thread,
    d: threadPath(thread.spec, { width: WIDTH, midY: MID_Y, amplitude: 44, wavelengths: 3.2 }),
  }))

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      fill="none"
      aria-hidden="true"
      className={cn("w-full", className)}
      preserveAspectRatio="xMidYMid meet"
    >
      <style>{`
        @keyframes weave-thread-in {
          from { opacity: 0; stroke-dashoffset: ${DASH_LENGTH}; }
          to { opacity: 0.92; stroke-dashoffset: 0; }
        }
        .weave-thread {
          stroke-dasharray: ${DASH_LENGTH};
          stroke-dashoffset: ${DASH_LENGTH};
          opacity: 0;
          animation: weave-thread-in 1.1s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @media (prefers-reduced-motion: reduce) {
          .weave-thread {
            animation: none;
            stroke-dashoffset: 0;
            opacity: 0.92;
          }
        }
      `}</style>
      {paths.map((thread, i) => (
        <path
          key={thread.label}
          d={thread.d}
          stroke={thread.color}
          strokeWidth={5}
          strokeLinecap="round"
          className="weave-thread"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
      {paths.map((thread) => (
        <text
          key={`${thread.label}-label`}
          x={4}
          y={thread.spec.startY - 14}
          fill={thread.color}
          fontSize="13"
          fontFamily="var(--font-mono)"
          letterSpacing="0.08em"
          opacity={0.75}
        >
          {thread.label}
        </text>
      ))}
    </svg>
  )
}
