// PW-1002 fixture: `payweave.config.ts` at the project root — resolved when
// `payweave.ts` is absent (cli.md §5 tier 1, second filename).
import { createPayweave } from "payweave";

export default createPayweave({
  paystack: { secretKey: "sk_test_root_config_ts" },
});
