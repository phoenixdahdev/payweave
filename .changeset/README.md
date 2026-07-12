# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets).
Only `payweave` is publishable — every other workspace package is `private`.

Add a changeset for any PR that changes `payweave`'s public API or behavior:

```bash
pnpm changeset
```

Classify semver honestly (TDD §14): breaking = any change to public types,
unified-mapping semantics, or error classes; provider-added response fields are
non-breaking because response schemas are loose.
