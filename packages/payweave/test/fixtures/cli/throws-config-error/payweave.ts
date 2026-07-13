// PW-1002 fixture: a REAL PayweaveConfigError thrown by createPayweave(...)
// itself (unified-config.md §2 rule 2 — zero provider keys). This is a
// CONFIG problem, not a loader problem: loadConfig must surface the SDK's
// own message verbatim, prefixed with this file's path, never swallow or
// generic-ify it.
import { createPayweave } from "payweave";

export default createPayweave({});
