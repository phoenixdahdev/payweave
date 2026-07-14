/**
 * Shared vocabulary for `payweave init`'s templates.
 *
 * Kept separate from `../init.ts` so the wizard's orchestration logic and its
 * string-template renderers can be read/tested independently — dist has no
 * runtime file reads (templates live under src/cli/templates/ as
 * string constants), so every renderer in this directory is a pure function
 * from a {@link ScaffoldInput} to a string, never an `fs.readFile` of a
 * template asset.
 */

/** A provider the wizard can configure. */
export type ProviderId = "stripe" | "paystack" | "flutterwave";

/**
 * A database choice offered by the wizard, plus `"none"` for a
 * payments-only project — the billing surface is entirely optional.
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
 * The four detection targets: Next.js App Router, Express,
 * Fastify — falls back to a plain http example. Next.js scaffolding only
 * targets the App Router convention, not "Next.js" generically — see
 * `../init.ts`'s `detectFramework` doc comment.
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
