// PW-1002 fixture: a plain thrown Error unrelated to Payweave (e.g. a bug in
// the user's own config file). loadConfig must wrap this as a generic
// "threw while loading" failure — distinct from the verbatim PayweaveError
// passthrough in throws-config-error/, and distinct from a jiti parse error.
throw new Error("boom from throws-generic-error fixture");
