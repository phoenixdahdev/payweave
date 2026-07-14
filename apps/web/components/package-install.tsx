// Adapted from EvilCharts (MIT) — package-manager-tabbed install block.
// Renders npm / pnpm / yarn / bun tabs for an install command, styled to match
// the EvilCharts docs. Built on Fumadocs' Tabs + DynamicCodeBlock primitives.
import { Tab, Tabs } from "fumadocs-ui/components/tabs"
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock"

const MANAGERS = [
  { id: "npm", command: (pkg: string) => `npm install ${pkg}` },
  { id: "pnpm", command: (pkg: string) => `pnpm add ${pkg}` },
  { id: "yarn", command: (pkg: string) => `yarn add ${pkg}` },
  { id: "bun", command: (pkg: string) => `bun add ${pkg}` },
] as const

/**
 * Package-manager install block with npm/pnpm/yarn/bun tabs.
 *
 * @example
 * <PackageInstall name="payweave" />
 */
export function PackageInstall({ name }: { name: string }) {
  return (
    <Tabs items={MANAGERS.map((m) => m.id)} label="Install">
      {MANAGERS.map((m) => (
        <Tab key={m.id} value={m.id}>
          <DynamicCodeBlock lang="bash" code={m.command(name)} />
        </Tab>
      ))}
    </Tabs>
  )
}
