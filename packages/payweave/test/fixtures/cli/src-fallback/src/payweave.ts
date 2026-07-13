// PW-1002 fixture: only `src/payweave.ts` exists — no root-level
// payweave.ts / payweave.config.ts in this fixture project, so resolution
// must fall through to cli.md §5 tier 2.
import { createPayweave } from "payweave";

export default createPayweave({
  paystack: { secretKey: "sk_test_src_fallback" },
});
