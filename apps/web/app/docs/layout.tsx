import { source } from "@/lib/source"
import type { ReactNode } from "react"
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
