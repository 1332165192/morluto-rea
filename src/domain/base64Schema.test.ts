import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { canonicalBase64Schema } from "./base64Schema.js";
import { CANONICAL_BASE64_PATTERN } from "./stringPatterns.js";

it("keeps runtime and projected canonical base64 contracts equivalent", () => {
  const samples = [
    "",
    "AA==",
    "AAA=",
    "////",
    "AB==",
    "AAB=",
    "A",
    "AA",
    "AAA",
    "====",
    "AA==\n",
    "AA==\r\n",
    "AA==\u2028",
    "AA==\u2029",
    "AA\nAA",
    "AA=\n=",
    "AA-_",
    "a b c",
    42,
    null,
  ];
  for (const io of ["input", "output"] as const) {
    const projected = z.toJSONSchema(canonicalBase64Schema, { io });
    const validate = new Ajv2020({ strict: true }).compile(projected);
    expect(JSON.stringify(projected)).not.toMatch(/\(\?<?[=!]/u);
    for (const sample of samples) {
      const expected =
        typeof sample === "string" && CANONICAL_BASE64_PATTERN.test(sample);
      expect(
        canonicalBase64Schema.safeParse(sample).success,
        String(sample),
      ).toBe(expected);
      expect(validate(sample), JSON.stringify({ io, sample })).toBe(expected);
    }
  }
});

it("validates large projected bodies without Unicode-set regexp stack exhaustion", () => {
  const encoded = Buffer.alloc(24 * 1024 * 1024 - 3, 0x81).toString("base64");
  const projected = z.toJSONSchema(canonicalBase64Schema);
  const validate = new Ajv2020({ strict: true }).compile(projected);
  const samples = [
    { value: encoded, expected: true },
    { value: `${encoded.slice(0, -1)}!`, expected: false },
    { value: `${encoded.slice(0, -3)}R==`, expected: false },
    { value: `${encoded}A`, expected: false },
  ];
  for (const { value, expected } of samples) {
    expect(canonicalBase64Schema.safeParse(value).success).toBe(expected);
    expect(validate(value)).toBe(expected);
    for (const flag of ["", "u", "v"]) {
      const positive = new RegExp(projected.pattern!, flag);
      const negative = new RegExp(
        (projected.not as { pattern: string }).pattern,
        flag,
      );
      expect(positive.test(value) && !negative.test(value), flag).toBe(
        expected,
      );
    }
  }
});
