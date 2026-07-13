// PW-1002 fixture: must NEVER be loaded — the sibling root `payweave.ts` in
// this same fixture project wins (cli.md §5's root tier precedes the src/
// fallback). Throwing here turns "resolution picked the wrong file" into a
// loud test failure instead of a silent wrong-client bug.
throw new Error(
  "root-beats-src/src/payweave.ts must never be loaded — the root payweave.ts wins (cli.md §5).",
);
