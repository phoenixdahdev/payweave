// Adapted from EvilCharts (https://github.com/legions-developer/evilcharts) — MIT
//
// Left docs navigation. Ports the structure of EvilCharts' docs sidebar
// (sidebar/index.tsx + render-default-options.tsx): a wordmark header, grouped
// section labels and menu items that each carry an icon. The active item is
// tracked by an animated indicator adapted from EvilCharts'
// sidebar/nav-main.tsx <TreeIndicator> — a faint guide rail with a spring-driven
// primary line and rotated diamond (motion v12) that slides to the active page.
// Payweave keeps its own wordmark, nav items and content; icons are Hugeicons.
"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import {
  SparklesIcon,
  Rocket01Icon,
  PlugSocketIcon,
  Layers01Icon,
  WebhookIcon,
  Alert02Icon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons"
import { motion, useSpring, useTransform } from "motion/react"

import { cn } from "@payweave/ui/lib/utils"
import { Wordmark } from "@/components/brand"

export type NavItem = { name: string; url: string }
export type NavGroup = { label: string; items: NavItem[] }

// Map each Payweave docs page to a Hugeicons glyph chosen to match EvilCharts'
// per-concept icon treatment as closely as the free set allows.
const ICONS: Record<string, IconSvgElement> = {
  "/docs": SparklesIcon, // Introduction
  "/docs/getting-started": Rocket01Icon, // Getting started
  "/docs/providers": PlugSocketIcon, // Providers
  "/docs/unified-layer": Layers01Icon, // Unified layer
  "/docs/webhooks": WebhookIcon, // Webhooks
  "/docs/errors-and-retries": Alert02Icon, // Errors & retries
}

const SPRING_CONFIG = { stiffness: 200, damping: 20 }

// Animated active-item indicator: a faint full-height guide rail with a
// spring-driven primary line and rotated diamond that slides to the active row.
function GroupIndicator({ center }: { center: number }) {
  const y = useSpring(center, SPRING_CONFIG)

  React.useEffect(() => {
    y.set(center)
  }, [center, y])

  const lineHeight = useTransform(y, (v) => Math.max(0, v))
  const diamondTop = useTransform(y, (v) => v - 3)

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-0 w-4"
    >
      {/* Faint full-height track */}
      <div className="bg-path absolute inset-y-1 left-[5.5px] w-px" />
      {/* Spring-driven primary segment growing to the active row */}
      <motion.div
        className="bg-primary absolute top-1 left-[5.5px] w-px"
        style={{ height: lineHeight }}
      />
      {/* Spring-driven rotated diamond at the active row */}
      <motion.div
        className="bg-primary absolute left-[3px] size-[6px] rounded-[1px]"
        style={{ top: diamondTop, rotate: 45 }}
      />
    </div>
  )
}

function SidebarGroup({
  group,
  pathname,
  onNavigate,
}: {
  group: NavGroup
  pathname: string
  onNavigate: () => void
}) {
  const listRef = React.useRef<HTMLUListElement>(null)
  const itemRefs = React.useRef<Array<HTMLLIElement | null>>([])
  const activeIndex = group.items.findIndex((item) => item.url === pathname)
  const [center, setCenter] = React.useState<number | null>(null)

  React.useLayoutEffect(() => {
    // Measure the active row's vertical centre so the indicator can spring to
    // it — a genuine DOM-measurement sync, which is what a layout effect is for.
    const el = activeIndex >= 0 ? itemRefs.current[activeIndex] : null
    const next = el ? el.offsetTop + el.offsetHeight / 2 : null
    setCenter(next)
  }, [activeIndex, group.items])

  return (
    <div className="mb-4">
      <p className="text-muted-foreground/70 px-2 py-1.5 text-xs font-medium">
        {group.label}
      </p>
      <ul ref={listRef} className="relative flex flex-col gap-0.5 pl-3">
        {activeIndex >= 0 && center != null ? (
          <GroupIndicator center={center} />
        ) : null}
        {group.items.map((item, index) => {
          const Icon = ICONS[item.url] ?? SourceCodeIcon
          const isActive = pathname === item.url
          return (
            <li
              key={item.url}
              ref={(el) => {
                itemRefs.current[index] = el
              }}
            >
              <Link
                href={item.url}
                onClick={onNavigate}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-muted-foreground/90 dark:text-muted-foreground/80 hover:text-primary hover:bg-sidebar-accent/50"
                )}
              >
                <HugeiconsIcon
                  icon={Icon}
                  size={16}
                  className="shrink-0"
                  aria-hidden
                />
                <span>{item.name}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function DocsSidebar({
  groups,
  open,
  onNavigate,
}: {
  groups: NavGroup[]
  open: boolean
  onNavigate: () => void
}) {
  const pathname = usePathname()

  return (
    <>
      {/* Mobile scrim */}
      <div
        aria-hidden
        onClick={onNavigate}
        className={cn(
          "bg-background/60 fixed inset-0 z-40 backdrop-blur-sm sidebar:hidden",
          open ? "block" : "hidden"
        )}
      />
      <aside
        className={cn(
          "bg-sidebar text-sidebar-foreground z-50 flex w-64 shrink-0 flex-col",
          // Mobile: off-canvas drawer toggled by the header menu button.
          "fixed inset-y-0 left-0 -translate-x-full transition-transform duration-200 sidebar:sticky sidebar:top-0 sidebar:h-svh sidebar:translate-x-0",
          open && "translate-x-0"
        )}
      >
        <div className="flex h-14 items-center px-4 pt-2 sidebar:h-auto sidebar:pt-6">
          <Link href="/" onClick={onNavigate}>
            <Wordmark />
          </Link>
        </div>
        <nav className="no-scrollbar flex-1 overflow-y-auto px-3 pt-2 pb-14 select-none">
          {groups.map((group) => (
            <SidebarGroup
              key={group.label}
              group={group}
              pathname={pathname}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
      </aside>
    </>
  )
}
