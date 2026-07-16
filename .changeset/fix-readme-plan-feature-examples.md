---
"payweave": patch
---

Fix the `plan()`/`feature()` examples in the package README — they showed a two-argument call shape (`plan("free", { includes: [...] })`); the actual API takes a single object with `id` inside it, and `feature()` returns a callable you invoke separately to build a plan's `includes`. Also refreshed the README's status line and added links to the docs site and GitHub ahead of launch.
