import type { NextConfig } from "next"
import { createMDX } from "fumadocs-mdx/next"

const nextConfig: NextConfig = {
  transpilePackages: ["@payweave/ui"],
}

const withMDX = createMDX()

export default withMDX(nextConfig)
