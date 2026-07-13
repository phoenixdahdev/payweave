// PW-1002 fixture: a named `payweave` export (no default) — cli.md §5's
// export contract accepts either. `otherStuff` proves the loader picks the
// right binding rather than merely checking "does default exist".
import { createPayweave } from "payweave";

export const otherStuff = 42;

export const payweave = createPayweave({
  paystack: { secretKey: "sk_test_named_export" },
});
