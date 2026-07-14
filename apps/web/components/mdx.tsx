import defaultMdxComponents from "fumadocs-ui/mdx"
import { Step, Steps } from "fumadocs-ui/components/steps"
import { Tab, Tabs } from "fumadocs-ui/components/tabs"
import type { MDXComponents } from "mdx/types"

import { PackageInstall } from "@/components/package-install"

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Steps,
    Step,
    Tabs,
    Tab,
    PackageInstall,
    ...components,
  }
}

export const useMDXComponents = getMDXComponents
