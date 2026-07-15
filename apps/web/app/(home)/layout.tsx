import { SiteNav } from "@/components/site-nav"
import { SiteFooter } from "@/components/site-footer"

export default function HomeLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <SiteNav />
      {children}
      <SiteFooter />
    </>
  )
}
