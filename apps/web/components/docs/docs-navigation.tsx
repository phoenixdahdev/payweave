// Adapted from EvilCharts (https://github.com/legions-developer/evilcharts) — MIT
//
// Ported from src/components/docs/mdx/components/navigation.tsx: the previous /
// next cards at the bottom of a docs page. Keeps EvilCharts' "life" on hover —
// the inset card whose border + title + arrow all light up to the primary
// colour — and adds a subtle motion entrance (fade + rise) that respects
// prefers-reduced-motion. Arrows are Hugeicons.
"use client"

import * as React from "react"
import Link from "next/link"
import { motion, useReducedMotion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons"

import { cn } from "@payweave/ui/lib/utils"

type Neighbour = { url: string; name: React.ReactNode }

function NavCard({
  type,
  neighbour,
}: {
  type: "previous" | "next"
  neighbour: Neighbour
}) {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      <Link href={neighbour.url}>
        <div
          className={cn(
            "dark:bg-primary-foreground group text-muted-foreground flex cursor-pointer rounded-md bg-[#F5F5F5] p-[2px]",
            type === "previous" ? "flex-row-reverse" : "flex-row"
          )}
        >
          <div
            className={cn(
              "bg-background group-hover:border-primary/20 flex flex-1 flex-col gap-0.5 rounded-md border p-3 duration-200",
              type === "previous" && "items-end text-right"
            )}
          >
            <span className="group-hover:text-primary line-clamp-1 text-[13px] font-medium capitalize duration-200">
              {neighbour.name}
            </span>
            <span className="text-muted-foreground/70 line-clamp-1 text-xs">
              {type === "previous" ? "Previous page" : "Next page"}
            </span>
          </div>
          <div className="group-hover:text-primary flex items-center duration-200 sm:px-2">
            <HugeiconsIcon
              icon={type === "previous" ? ArrowLeft01Icon : ArrowRight01Icon}
              size={20}
              strokeWidth={1.5}
              className={cn(
                "transition-transform duration-200",
                type === "previous"
                  ? "group-hover:-translate-x-0.5"
                  : "group-hover:translate-x-0.5"
              )}
            />
          </div>
        </div>
      </Link>
    </motion.div>
  )
}

export function DocsNavigation({
  previous,
  next,
}: {
  previous?: Neighbour
  next?: Neighbour
}) {
  return (
    <div className="mt-16 grid grid-cols-2 gap-4 sm:gap-8">
      <div>
        {previous ? (
          <NavCard type="previous" neighbour={previous} />
        ) : (
          <div className="h-full rounded-md border border-dashed" />
        )}
      </div>
      <div>
        {next ? (
          <NavCard type="next" neighbour={next} />
        ) : (
          <div className="h-full rounded-md border border-dashed" />
        )}
      </div>
    </div>
  )
}
