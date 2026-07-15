import type { Metadata } from "next"
import { Bricolage_Grotesque, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google"
import { RootProvider } from "fumadocs-ui/provider/next"

import "./globals.css"
import { cn } from "@payweave/ui/lib/utils"

const fontDisplay = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
})

const fontSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
})

const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
})

export const metadata: Metadata = {
  metadataBase: new URL("https://payweave.dev"),
  title: {
    default: "Payweave — One SDK, every provider, woven together",
    template: "%s · Payweave",
  },
  description:
    "The unified, fully-typed TypeScript SDK for Stripe, Paystack, and Flutterwave — one client, any provider, with subscriptions, metered usage, a database layer, and a CLI built in.",
  openGraph: {
    title: "Payweave — One SDK, every provider, woven together",
    description:
      "The unified, fully-typed TypeScript SDK for Stripe, Paystack, and Flutterwave.",
    url: "https://payweave.dev",
    siteName: "Payweave",
    type: "website",
  },
  icons: {
    icon: "/favicon.svg",
  }
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
      className={cn(fontDisplay.variable, fontSans.variable, fontMono.variable)}
    >
      <body className="font-sans flex min-h-svh flex-col antialiased">
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
