"use client"

import * as React from "react"

/** Not from `motion` — its reduced-motion hook isn't reliably exported across
 * versions/subpaths, and this is one dependency-free line. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const listener = (e: MediaQueryListEvent) => setReduced(e.matches)
    query.addEventListener("change", listener)
    return () => query.removeEventListener("change", listener)
  }, [])
  return reduced
}
