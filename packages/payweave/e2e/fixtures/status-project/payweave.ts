// PW-609 `contract.yml` fixture: a minimal "real project" `payweave.ts` for
// `payweave status --throw` (docs/v1/cli.md §4/§9's contract.yml wiring —
// PW-1003 left a NOTE in src/cli/status.ts for this ticket to wire it up).
//
// This imports the SDK by a relative path into `src/` (loaded at runtime by
// the built CLI's jiti loader, which transpiles TS on the fly — no build
// step required for THIS file) rather than the bare `"payweave"` specifier
// `test/fixtures/cli/**`'s fixtures use: those exist to prove config
// discovery resolves a REAL installed dependency (requiring a symlinked
// `node_modules/payweave`, cli.md §5); this fixture's only job is to give
// `payweave status --throw` a real, loadable client to introspect before
// contract.yml's e2e suites run, which a relative import does with zero
// extra CI setup. Packaging correctness (the bare-specifier / real-install
// case) is already covered by `scripts/test-cli-tarball.mjs`'s CI job.
//
// `STRIPE_TEST_SECRET` is required — this fixture is ONLY ever loaded by the
// contract.yml job that is itself guarded on that secret being present
// (`if: secrets.STRIPE_TEST_SECRET`), never locally and never in the PR gate.
import { createPayweave } from "../../../src/index";

export default createPayweave({
  stripe: { secretKey: process.env.STRIPE_TEST_SECRET ?? "" },
});
