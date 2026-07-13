---
"payweave": minor
---

CLI packaging skeleton (PW-1001): the package now ships a `payweave` bin — `npx payweave --help` and `npx payweave --version` work straight from the published tarball. Subcommands `init`/`push`/`listen`/`status` are registered as placeholders that exit non-zero naming the ticket that ships them (PW-1002–PW-1007). Runtime `dependencies` stay zod-only: CLI-only deps are devDependencies inlined into `dist/cli/index.js` by a dedicated tsup pass (docs/v1/cli.md §7). The `payweave/cli` import subpath (a PW-505 placeholder that only ever threw) is removed — the bin field is the CLI's only entry point.
