// PW-1002 fixture: a default export that exists but is not a Payweave client
// — resolution succeeds, loading succeeds, but export-shape detection must
// reject it with an actionable message (not a silent `undefined` client).
export default {
  iAmNot: "a createPayweave() client",
};
