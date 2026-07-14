import type { Metadata } from "next"
import { Inter, Geist, JetBrains_Mono } from "next/font/google"
import { RootProvider } from "fumadocs-ui/provider/next"

import "./globals.css"
import { cn } from "@payweave/ui/lib/utils"

// Fonts mirror EvilCharts (https://github.com/legions-developer/evilcharts, MIT):
// Inter is the default UI font, Geist backs `--font-sans`, JetBrains Mono is the
// mono font. Variable names match EvilCharts' layout exactly.
const fontInter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
})

const fontGeist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
})

const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
})

export const metadata: Metadata = {
  metadataBase: new URL("https://payweave.dev"),
  title: {
    default: "Payweave — One SDK, every provider, woven together",
    template: "%s · Payweave",
  },
  description:
    "The unified, fully-typed TypeScript SDK for Paystack and Flutterwave. One install, one mental model, full endpoint coverage, and webhook verification done correctly out of the box.",
  openGraph: {
    title: "Payweave — One SDK, every provider, woven together",
    description:
      "The unified, fully-typed TypeScript SDK for Paystack and Flutterwave.",
    url: "https://payweave.dev",
    siteName: "Payweave",
    type: "website",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
      className={cn(
        fontInter.variable,
        fontGeist.variable,
        fontMono.variable
      )}
    >
      <body className="font-inter flex min-h-svh flex-col antialiased">
        <RootProvider
          theme={{
            defaultTheme: "dark",
            enableSystem: false,
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
