/**
 * Command registration surface for the `payweave` CLI.
 *
 * The shape here (name/summary/run + injectable io) is the registration
 * contract the dispatch table in `./run` consumes. Everything under
 * `src/cli/` is bundled into `dist/cli/index.js` by `tsup.cli.config.ts` and
 * is unreachable from library imports (bin-only).
 */

/** Injectable output sinks so tests can capture CLI output without spies. */
export interface CliIo {
  /** Write one line to stdout. */
  out: (line: string) => void;
  /** Write one line to stderr. */
  err: (line: string) => void;
}

/** Default io: the real terminal (console.* is allowed inside src/cli). */
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
  run: (argv: readonly string[], io: CliIo) => number | Promise<number>;
}
