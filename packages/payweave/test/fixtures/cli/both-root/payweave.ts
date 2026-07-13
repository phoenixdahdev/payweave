// PW-1002 fixture: ambiguous config — this fixture ALSO has a sibling
// payweave.config.ts. cli.md §5 resolves at most one of the two root
// filenames; both present at once is a distinct failure mode, so resolution
// must throw before either file is loaded. Content is irrelevant but kept
// valid in case a resolver regression loads it anyway.
import { createPayweave } from "payweave";

export default createPayweave({
  paystack: { secretKey: "sk_test_both_root_a" },
});
