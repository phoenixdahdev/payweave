import { docs } from "collections/server"
import { loader } from "fumadocs-core/source"
import { HugeiconsIcon } from "@hugeicons/react"
import type { IconSvgElement } from "@hugeicons/react"
import {
  SparklesIcon,
  RocketIcon,
  PlugSocketIcon,
  Exchange01Icon,
  WebhookIcon,
  Alert01Icon,
  Book02Icon,
  DatabaseIcon,
  Wallet01Icon,
  ChartIncreaseIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons"

/**
 * Docs page-tree icons. Each key is the `icon` value set in a page's MDX
 * frontmatter (or a `---[Icon]Section---` separator); the resolver below maps it
 * to a Hugeicons node so every sidebar item renders with an icon — matching the
 * EvilCharts docs sidebar. Hugeicons only (verified against the package exports).
 */
const icons: Record<string, IconSvgElement> = {
  Sparkles: SparklesIcon,
  Book: Book02Icon,
  Rocket: RocketIcon,
  PlugSocket: PlugSocketIcon,
  Exchange: Exchange01Icon,
  Webhook: WebhookIcon,
  Alert: Alert01Icon,
  Database: DatabaseIcon,
  Wallet: Wallet01Icon,
  ChartIncrease: ChartIncreaseIcon,
  Terminal: TerminalIcon,
}

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  icon(name) {
    const icon = name ? icons[name] : undefined
    if (icon) {
      return (
        <HugeiconsIcon icon={icon} className="size-4 shrink-0" aria-hidden />
      )
    }
  },
})
