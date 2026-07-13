// PW-1002 fixture: the sibling half of the ambiguous-config case — see
// payweave.ts in this same directory.
import { createPayweave } from "payweave";

export default createPayweave({
  paystack: { secretKey: "sk_test_both_root_b" },
});
