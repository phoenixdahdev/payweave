// PW-1002 fixture: `payweave.ts` at the project root (cli.md §5 tier 1 —
// checked before `payweave.config.ts` and before the `src/` fallback). Also
// doubles as the "a TS config that imports payweave loads via jiti and
// yields the client" case: this is a real `import` of the `payweave` package
// (resolved from this fixture's own `node_modules`, set up by the test's
// shared symlink — never the loader's own bundled copy) and a real
// `createPayweave(...)` call.
import { createPayweave } from "payweave";

export default createPayweave({
  paystack: { secretKey: "sk_test_root_ts" },
});
