// PW-1002 fixture: malformed TypeScript — jiti's transform must fail with a
// parse error (surfaced with the file path + jiti's own message, which
// already carries line:col position info), distinct from every runtime
// throw-while-loading case in the other fixtures.
export const broken: = ;;;
