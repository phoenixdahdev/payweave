/**
 * `payweave` CLI dispatch.
 *
 * Argument parsing uses `mri` — the smallest pure-JS zero-dependency option
 * for this. The dispatch table itself is hand-rolled; subcommands register
 * through the `CliCommand` shape in `./command`, each swapping in its own
 * real body.
 *
 * Exit codes: 0 success · 1 command failure · 2 usage error (unknown command).
 */
import mri from "mri";

import { defaultIo } from "./command";
import type { CliCommand, CliIo } from "./command";
import { initCommand } from "./init";
import { listenCommand } from "./listen";
import { pushCommand } from "./push";
import { statusCommand } from "./status";
import { withTelemetry } from "./telemetry";
import { CLI_VERSION } from "./version";

/** Dispatch table, in docs order. */
export const COMMANDS: readonly CliCommand[] = [
  initCommand,
  pushCommand,
  listenCommand,
  statusCommand,
];

const usage = (): string => {
  const pad = Math.max(...COMMANDS.map((c) => c.name.length)) + 3;
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(pad)}${c.summary}`);
  return [
    "payweave — one SDK, every provider, woven together",
    "",
    "Usage",
    "  payweave <command> [options]",
    "",
    "Commands",
    ...lines,
    "",
    "Options",
    "  -h, --help     Show this help",
    "  -v, --version  Print the CLI version",
    "",
    "Docs: https://github.com/phoenixdahdev/payweave",
  ].join("\n");
};

/**
 * Parse argv (everything after `payweave`) and dispatch. Returns the process
 * exit code; the bin entry (`./index`) assigns it to `process.exitCode`.
 *
 * Bare `payweave` prints usage and exits 0, same as `--help` — the friendly
 * `npx payweave` discovery path. Unknown commands exit 2 with usage on stderr.
 */
export async function run(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const args = mri([...argv], {
    boolean: ["help", "version"],
    alias: { h: "help", v: "version" },
  });

  // Global --help always wins wherever it appears (subcommands grow their own
  // help pages later). --version/-v is honored only without a command
  // so subcommands stay free to claim -v (e.g. --verbose) for themselves.
  if (args["help"] === true) {
    io.out(usage());
    return 0;
  }

  // The command is the first non-flag token of the RAW argv; everything after
  // it is handed to the subcommand verbatim (mri must not eat subcommand
  // flags like `push -y` here — each command owns its own parse).
  const commandName = argv.find((token) => !token.startsWith("-"));
  if (commandName === undefined) {
    if (args["version"] === true) {
      io.out(CLI_VERSION);
      return 0;
    }
    io.out(usage());
    return 0;
  }

  const command = COMMANDS.find((c) => c.name === commandName);
  if (command === undefined) {
    io.err(`payweave: unknown command "${commandName}"`);
    io.err("");
    io.err(usage());
    return 2;
  }

  // anonymous usage telemetry (see src/cli/telemetry.ts).
  // Wraps ONLY the matched command below (never --help/--version/unknown
  // above); kept as its own function/module, decoupled from the rest of
  // this file's command-registration logic.
  return withTelemetry(command.name, () => command.run(argv.slice(argv.indexOf(commandName) + 1), io), io);
}
