// PW-1002 fixture: precedence — a root `payweave.ts` must win even though
// `src/payweave.ts` also exists (cli.md §5: root tier before the src/
// fallback). The src/ sibling in this fixture deliberately throws so a
// resolver regression (picking src/ first) fails the test loudly instead of
// silently loading the wrong file.
import { createPayweave } from "payweave";

export default createPayweave({
  paystack: { secretKey: "sk_test_root_beats_src" },
});
