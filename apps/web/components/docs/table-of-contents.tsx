// Adapted from EvilCharts (https://github.com/legions-developer/evilcharts) — MIT
//
// "On This Page" table of contents, ported from EvilCharts'
// mdx/components/table-of-content.tsx (originally from the shadcn docs). Uses the
// TOC entries fumadocs extracts from the page, a scroll-spy IntersectionObserver
// to track the active heading, and the animated <TocIndicator> that springs to
// it. Icons are Hugeicons.
"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Menu02Icon } from "@hugeicons/core-free-icons"

import { cn } from "@payweave/ui/lib/utils"
import { TocIndicator } from "@/components/docs/toc-indicator"

type TocItem = {
  title: React.ReactNode
  url: string
  depth: number
}

function useActiveItem(itemIds: string[]) {
  const [activeId, setActiveId] = React.useState<string | null>(null)

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
          }
        }
      },
      { rootMargin: "0% 0% -60% 0%" }
    )

    for (const id of itemIds ?? []) {
      const element = document.getElementById(id)
      if (element) observer.observe(element)
    }

    return () => {
      for (const id of itemIds ?? []) {
        const element = document.getElementById(id)
        if (element) observer.unobserve(element)
      }
    }
  }, [itemIds])

  return activeId
}

export function DocsTableOfContents({
  toc,
  className,
}: {
  toc: TocItem[]
  className?: string
}) {
  const itemIds = React.useMemo(
    () => toc.map((item) => item.url.replace("#", "")),
    [toc]
  )
  const activeHeading = useActiveItem(itemIds)
  const activeIndex = activeHeading ? itemIds.indexOf(activeHeading) : -1

  if (!toc?.length) return null

  return (
    <div
      className={cn("flex flex-col px-4 pt-0 text-sm select-none", className)}
    >
      <div className="flex h-6 flex-row items-center gap-[5px]">
        <HugeiconsIcon
          icon={Menu02Icon}
          size={14}
          className="text-muted-foreground"
        />
        <p className="text-muted-foreground/75 bg-background sticky top-0 text-xs">
          On This Page
        </p>
      </div>
      <div className="relative flex flex-row">
        <TocIndicator toc={toc} activeIndex={activeIndex} />
        <div className="flex h-fit flex-col gap-2 pt-2">
          {toc.map((item) => (
            <a
              key={item.url}
              href={item.url}
              className="text-muted-foreground/75 hover:text-foreground data-[active=true]:text-foreground text-[0.8rem] no-underline transition-colors duration-200 empty:hidden data-[active=true]:font-medium data-[depth=1]:pl-5 data-[depth=2]:pl-5 data-[depth=3]:pl-8 data-[depth=4]:pl-11"
              data-active={item.url === `#${activeHeading}`}
              data-depth={item.depth}
            >
              {item.title}
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
