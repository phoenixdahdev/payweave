/**
 * Command registration surface for the `payweave` CLI (docs/v1/cli.md; PW-1001).
 *
 * PW-1002+ replace the placeholder `run` bodies with real implementations; the
 * shape here (name/summary/run + injectable io) is the registration contract
 * the dispatch table in `./run` consumes. Everything under `src/cli/` is
 * bundled into `dist/cli/index.js` by `tsup.cli.config.ts` and is unreachable
 * from library imports (cli.md §7 — bin-only).
 */

/** Injectable output sinks so tests can capture CLI output without spies. */
export interface CliIo {
  /** Write one line to stdout. */
  out: (line: string) => void;
  /** Write one line to stderr. */
  err: (line: string) => void;
}

/** Default io: the real terminal (console.* is allowed inside src/cli — cli.md §7). */
export const defaultIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/**
 * A registered CLI subcommand. `run` receives the argv AFTER the command name
 * and resolves to the process exit code (0 ok, 1 command failure, 2 usage error).
 */
export interface CliCommand {
  /** The subcommand name as typed by the user (`payweave <name>`). */
  readonly name: string;
  /** One-line description shown in `payweave --help`. */
  readonly summary: string;
  /** Backlog ticket that ships the real implementation (placeholder phase only). */
  readonly ticket: string;
  run: (argv: readonly string[], io: CliIo) => number | Promise<number>;
}

/**
 * Placeholder used until the owning ticket lands: prints where the command is
 * tracked and fails (exit 1) so scripts never mistake a no-op for success.
 */
export const placeholderCommand = (
  name: string,
  summary: string,
  ticket: string,
  specSection: string,
): CliCommand => ({
  name,
  summary,
  ticket,
  run: (_argv, io) => {
    io.err(
      `payweave ${name} is not available yet — it ships with ${ticket} ` +
        `(EPIC 10, docs/v1/cli.md ${specSection}).`,
    );
    return 1;
  },
});
