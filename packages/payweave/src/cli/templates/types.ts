/**
 * Shared vocabulary for `payweave init`'s templates (docs/v1/cli.md §1, PW-1005).
 *
 * Kept separate from `../init.ts` so the wizard's orchestration logic and its
 * string-template renderers can be read/tested independently — dist has no
 * runtime file reads (cli.md §8: "templates live under src/cli/templates/ as
 * string constants"), so every renderer in this directory is a pure function
 * from a {@link ScaffoldInput} to a string, never an `fs.readFile` of a
 * template asset.
 */

/** A provider the wizard can configure — the `unified-config.md` §2 keyed set. */
export type ProviderId = "stripe" | "paystack" | "flutterwave";

/**
 * A database choice offered by the wizard (database.md §1's adapter list,
 * plus `"none"` for a payments-only project — the billing surface is
 * entirely optional, unified-config.md §2 rule 5).
 */
export type DatabaseChoice =
  | "none"
  | "prisma"
  | "drizzle"
  | "postgres"
  | "mysql"
  | "sqlite"
  | "mongodb";

/**
 * The four detection targets cli.md §1 names: "Next.js App Router, Express,
 * Fastify — falls back to a plain http example." Next.js scaffolding only
 * targets the App Router convention (the spec names that specifically, not
 * "Next.js" generically) — see `../init.ts`'s `detectFramework` doc comment.
 */
export type FrameworkId = "next" | "express" | "fastify" | "node";

/** Answers the wizard collected, plus the detected framework — input to every renderer. */
export interface ScaffoldInput {
  readonly providers: readonly ProviderId[];
  readonly database: DatabaseChoice;
  readonly framework: FrameworkId;
}

/** One file the wizard plans to write, relative to the project root. */
export interface ScaffoldFile {
  readonly relPath: string;
  readonly contents: string;
}
