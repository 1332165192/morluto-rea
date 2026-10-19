/** Portable ASCII identifier starting with a letter. */
export const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._\x2d]*$/u;

/** Stable evidence identifier, also admitting namespace and path separators. */
export const STABLE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:\x2f\x2d]*$/u;

// Repeated alphabet quartets exhaust V8's regexp stack on large bodies,
// especially under JSON Schema's Unicode-set mode. Check invalid content
// separately from an unconstrained fixed-width loop for length.
export const BASE64_QUARTETS_PATTERN = /^(?:....)*$/;
const PADDED_BASE64_INVALID_PATTERN = /[^A-Za-z0-9+\x2f=]|=[^=]|===/;
export const CANONICAL_BASE64_INVALID_PATTERN = new RegExp(
  `${PADDED_BASE64_INVALID_PATTERN.source}|[^AQgw]==$|[^AEIMQUYcgkosw048=]=$`,
);

const excludingInvalidBase64 = (invalid: RegExp): RegExp =>
  new RegExp(
    `^(?!.*(?:${invalid.source}))${BASE64_QUARTETS_PATTERN.source.slice(1)}`,
  );

/** Padded base64 syntax, allowing nonzero pad bits and the empty encoding. */
export const PADDED_BASE64_PATTERN = excludingInvalidBase64(
  PADDED_BASE64_INVALID_PATTERN,
);

/** Canonical padded base64, including zero pad bits and the empty encoding. */
export const CANONICAL_BASE64_PATTERN = excludingInvalidBase64(
  CANONICAL_BASE64_INVALID_PATTERN,
);
