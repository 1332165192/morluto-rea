import { z } from "zod";

import {
  BASE64_QUARTETS_PATTERN,
  CANONICAL_BASE64_INVALID_PATTERN,
} from "./stringPatterns.js";

/** Exact canonical base64 using stack-bounded, portable JSON Schema patterns. */
export const canonicalBase64Schema = z
  .string()
  .regex(BASE64_QUARTETS_PATTERN)
  .refine((value) => !CANONICAL_BASE64_INVALID_PATTERN.test(value), {
    message: "Expected canonical padded base64",
  })
  // JSON Schema negation expresses the same rejection without look-around.
  .meta({ not: { pattern: CANONICAL_BASE64_INVALID_PATTERN.source } });
