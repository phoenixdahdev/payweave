import type { Metadata } from "next"

import "./globals.css"

export const metadata: Metadata = {
  title: "Payweave Next.js example",
  description:
    "Minimal Next.js App Router integration of the payweave payments SDK, using Stripe as the provider.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
