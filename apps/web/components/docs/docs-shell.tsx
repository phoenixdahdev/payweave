// Adapted from EvilCharts (https://github.com/legions-developer/evilcharts) — MIT
//
// Docs shell layout, ported from EvilCharts' app/docs/layout.tsx: a left sidebar
// on the sidebar background, and the page content rendered as a rounded panel
// floating on that background with a decorative notch cut into the top-right
// where the header controls sit. The scroll container uses the `no-scrollbar`
// utility so no scrollbar is ever visible.

"use client"

import * as React from "react"

import DecorativeBorder from "@/components/docs/decorative-border-svg"
import { DocsSidebar, type NavGroup } from "@/components/docs/docs-sidebar"
import { DocsHeader } from "@/components/docs/docs-header"

export function DocsShell({
  groups,
  children,
}: {
  groups: NavGroup[]
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <div className="bg-sidebar flex min-h-svh w-full">
      <DocsSidebar
        groups={groups}
        open={open}
        onNavigate={() => setOpen(false)}
      />
      <div className="bg-sidebar relative w-full min-w-0 flex-1 p-0 sm:p-2">
        <DecorativeBorder />
        <div className="no-scrollbar bg-background relative h-svh overflow-y-scroll sm:h-[calc(100vh-1rem)] sm:overscroll-none sm:rounded-tl-md sm:rounded-br-xl sm:rounded-bl-md sm:border">
          <DocsHeader onMenu={() => setOpen(true)} />
          {children}
        </div>
      </div>
    </div>
  )
}
