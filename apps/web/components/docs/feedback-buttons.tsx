// Adapted from EvilCharts (https://github.com/legions-developer/evilcharts) — MIT
//
// Ported from src/components/docs/mdx/components/feedback-buttons.tsx. A
// client-side "Did you like the content?" block with Good / Bad buttons that
// only toggle local state (no data submission / no backend). Icons are
// Hugeicons; the buttons use the shared Payweave <Button>.
"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ThumbsUpIcon, ThumbsDownIcon } from "@hugeicons/core-free-icons"

import { Button } from "@payweave/ui/components/button"
import { cn } from "@payweave/ui/lib/utils"

type FeedbackType = "good" | "bad" | null

export function FeedbackButtons() {
  const [feedback, setFeedback] = React.useState<FeedbackType>(null)

  return (
    <div className="flex flex-row items-center gap-4">
      <span className="text-muted-foreground text-sm">
        Did you like the content?
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          nativeButton
          onClick={() => setFeedback("good")}
          className={cn(
            feedback === "good"
              ? "text-primary border-primary/50 dark:border-primary/50"
              : "text-muted-foreground dark:text-muted-foreground/80 hover:text-primary"
          )}
        >
          <HugeiconsIcon icon={ThumbsUpIcon} size={16} />
          <span>Good</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          nativeButton
          onClick={() => setFeedback("bad")}
          className={cn(
            feedback === "bad"
              ? "text-primary border-primary/50 dark:border-primary/50"
              : "text-muted-foreground dark:text-muted-foreground/80 hover:text-primary"
          )}
        >
          <HugeiconsIcon icon={ThumbsDownIcon} size={16} />
          <span>Bad</span>
        </Button>
      </div>
    </div>
  )
}
