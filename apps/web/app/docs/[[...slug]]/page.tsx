// Adapted from EvilCharts (https://github.com/legions-developer/evilcharts) — MIT
//
// Docs page renderer. Ports EvilCharts' app/docs/[[...slug]]/page.tsx layout: a
// centred content column (title + description + "Copy Page", the MDX body, then
// previous/next navigation) with an "On This Page" table of contents pinned to
// the right. Payweave keeps its own content and MDX components.
import { createRelativeLink } from "fumadocs-ui/mdx"
import { findNeighbour } from "fumadocs-core/page-tree"
import { notFound } from "next/navigation"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Metadata } from "next"

import { source } from "@/lib/source"
import { getMDXComponents } from "@/components/mdx"
import { CopyPageButton } from "@/components/copy-page-button"
import { DocsTableOfContents } from "@/components/docs/table-of-contents"
import { DocsNavigation } from "@/components/docs/docs-navigation"
import { FeedbackButtons } from "@/components/docs/feedback-buttons"

// Statically-scoped to the content/docs subfolder so the build's dependency
// tracer doesn't walk the whole project (per the Turbopack NFT guidance).
const DOCS_DIR = path.join(process.cwd(), "content/docs")

/**
 * Reads the page's source MDX at build time (pages are statically generated) and
 * strips the frontmatter block, so the "Copy Page" button can hand readers clean
 * Markdown. Falls back to the title/description if the file can't be read.
 */
async function getPageMarkdown(
  relativePath: string,
  fallback: string
): Promise<string> {
  try {
    const raw = await readFile(path.join(DOCS_DIR, relativePath), "utf8")
    return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim()
  } catch {
    return fallback
  }
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>
}) {
  const params = await props.params
  const page = source.getPage(params.slug)
  if (!page) notFound()

  const MDX = page.data.body
  const neighbours = findNeighbour(source.pageTree, page.url)
  const markdown = await getPageMarkdown(
    page.path,
    `# ${page.data.title}\n\n${page.data.description ?? ""}`
  )

  return (
    <div className="relative mt-4 flex sm:mt-0">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-10 pb-32">
        <div className="flex flex-row items-start gap-4">
          <div className="flex flex-1 flex-col gap-1">
            <h1 className="scroll-m-20 text-3xl font-semibold tracking-tight xl:text-4xl">
              {page.data.title}
            </h1>
            {page.data.description && (
              <p className="text-muted-foreground text-[15px]">
                {page.data.description}
              </p>
            )}
          </div>
          <CopyPageButton
            markdown={markdown}
            url={page.url}
            className="mt-1 shrink-0"
          />
        </div>

        <div className="prose prose-neutral dark:prose-invert mt-8 w-full max-w-none">
          <MDX
            components={getMDXComponents({
              a: createRelativeLink(source, page),
            })}
          />
        </div>

        <div className="mt-16 flex justify-end border-t pt-6">
          <FeedbackButtons />
        </div>

        <DocsNavigation
          previous={
            neighbours.previous
              ? {
                  url: neighbours.previous.url,
                  name: neighbours.previous.name,
                }
              : undefined
          }
          next={
            neighbours.next
              ? { url: neighbours.next.url, name: neighbours.next.name }
              : undefined
          }
        />
      </div>

      <div className="sticky top-[35px] hidden h-fit self-start py-10 xl:flex">
        {page.data.toc?.length ? (
          <div className="no-scrollbar max-h-[calc(100vh-6rem)] w-72 overflow-y-auto">
            <DocsTableOfContents toc={page.data.toc} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function generateStaticParams() {
  return source.generateParams()
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>
}): Promise<Metadata> {
  const params = await props.params
  const page = source.getPage(params.slug)
  if (!page) notFound()

  return {
    title: page.data.title,
    description: page.data.description,
  }
}
