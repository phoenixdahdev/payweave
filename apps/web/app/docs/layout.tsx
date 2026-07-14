// Adapted from EvilCharts (https://github.com/legions-developer/evilcharts) — MIT
//
// Docs layout. Instead of the stock fumadocs shell, Payweave ports EvilCharts'
// docs layout: a left sidebar on the sidebar background with the content
// rendered as a rounded panel that has a decorative notch cut into the
// top-right for the controls. The nav groups are derived from the fumadocs page
// tree (Payweave's own pages), then handed to the client shell.
import type { ReactNode } from "react"

import { source } from "@/lib/source"
import { DocsShell } from "@/components/docs/docs-shell"
import type { NavGroup } from "@/components/docs/docs-sidebar"

function buildNavGroups(): NavGroup[] {
  const groups: NavGroup[] = []
  let current: NavGroup | null = null

  for (const node of source.pageTree.children) {
    if (node.type === "separator") {
      current = { label: String(node.name), items: [] }
      groups.push(current)
    } else if (node.type === "page") {
      if (!current) {
        current = { label: "Documentation", items: [] }
        groups.push(current)
      }
      current.items.push({ name: String(node.name), url: node.url })
    }
  }

  return groups
}

export default function Layout({ children }: { children: ReactNode }) {
  return <DocsShell groups={buildNavGroups()}>{children}</DocsShell>
}
