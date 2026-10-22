import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyManagedNativeBoundariesEvidence } from "../../../../src/application/managed/ManagedNativeVerificationService.js";
import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../../../../src/contracts/managed/managedWorkflowExamples.js";
import { createEvidence } from "../../../../src/domain/evidence.js";
import {
  managedNativeVerificationInputSchema,
  managedNativeVerificationResultSchema,
  pinvokeVerificationSchema,
} from "../../../../src/domain/managed/managedNativeVerificationSchemas.js";
import { managedNativeBoundaryInspectionSchema } from "../../../../src/domain/managed/managedArtifact.js";
import { inspectMachoSchema } from "../../../../src/domain/native/nativeInspection.js";

import { verifyManagedNativeBoundaries } from "../../../../src/domain/managed/managedNativeVerification.js";
import { NATIVE_EXPORTS_PROVIDER } from "../../../../src/application/InvestigationProviders.js";
import { parseNativeExports } from "../../../../src/native/exports/NativeExportParser.js";
import {
  elfExportImage,
  peExportImage,
} from "../../../fixtures/binaryDiagnostics/nativeExports.js";
const exampleInput = () =>
  managedNativeVerificationInputSchema.parse(
    MANAGED_NATIVE_VERIFICATION_EXAMPLE,
  );

const nativeEvidenceWithExports = (
  names: readonly string[],
  path?: string,
  subjectless = false,
) => {
  const input = exampleInput();
  const native = input.native_observations[0];
  if (native === undefined || native.subject === null)
    throw new Error("missing native example");
  const macho = inspectMachoSchema.parse(native.normalized_result);
  return createEvidence(
    subjectless
      ? undefined
      : {
          path: path ?? native.subject.local_path,
          sha256: native.subject.digest.sha256,
          format: native.subject.format,
          ...(native.subject.architecture === null
            ? {}
            : { architecture: native.subject.architecture }),
        },
    native.provider,
    {
      operation: native.operation,
      parameters: native.parameters,
      result: {
        ...macho,
        exports: {
          ...macho.exports,
          items: names.map((name, index) => ({
            name,
            address: `0x${(0x1000 + index).toString(16)}`,
            weak: false,
            reexport: false,
            source: "nm",
          })),
          total: names.length,
        },
      },
      rawResult: native.raw_result,
      confidence: native.confidence,
      authority: native.authority,
      environment: native.environment,
      limitations: native.limitations,
      locations: native.locations,
      evidenceLinks: native.evidence_links,
    },
  );
};

const inputWithImportScope = (scope: string | null) => {
  const input = exampleInput();
  const managed = input.managed_boundaries;
  const normalized = managedNativeBoundaryInspectionSchema.parse(
    managed.normalized_result,
  );
  return {
    ...input,
    managed_boundaries: createEvidence(undefined, managed.provider, {
      operation: managed.operation,
      parameters: managed.parameters,
      result: {
        ...normalized,
        pinvoke_imports: normalized.pinvoke_imports.map((item) => ({
          ...item,
          import_scope_name: scope,
        })),
      },
      rawResult: null,
    }),
  };
};

it("keeps empty import names readable in managed Evidence but invalid in verification output", () => {
  const input = exampleInput();
  const parsed = managedNativeBoundaryInspectionSchema.parse(
    input.managed_boundaries.normalized_result,
  );
  const declaration = parsed.pinvoke_imports[0];
  if (declaration === undefined) throw new Error("missing P/Invoke example");

  const historicalBoundary = managedNativeBoundaryInspectionSchema.parse({
    ...parsed,
    pinvoke_imports: [{ ...declaration, import_name: "" }],
  });
  expect(historicalBoundary.pinvoke_imports[0]?.import_name).toBe("");

  const verification = verifyManagedNativeBoundaries(input).pinvoke_imports[0];
  if (verification === undefined)
    throw new Error("missing verification result");
  expect(
    pinvokeVerificationSchema.safeParse({
      ...verification,
      managed: { ...verification.managed, import_name: "" },
    }).success,
  ).toBe(false);
});

describe("managed/native boundary Evidence identity", () => {
  it("rejects managed boundary Evidence whose subject digest differs from its artifact", () => {
    const input = exampleInput();
    const managed = input.managed_boundaries;
    const result = managedNativeBoundaryInspectionSchema.parse(
      managed.normalized_result,
    );
    const otherDigest = "b".repeat(64);
    const mismatched = createEvidence(
      {
        path: result.artifact.path,
        sha256: result.artifact.sha256,
        format: "pe",
      },
      managed.provider,
      {
        operation: managed.operation,
        parameters: managed.parameters,
        result: {
          ...result,
          artifact: { ...result.artifact, sha256: otherDigest },
          identity_scope: {
            ...result.identity_scope,
            requires_artifact_sha256: otherDigest,
          },
        },
        rawResult: managed.raw_result,
        confidence: managed.confidence,
        authority: managed.authority,
        environment: managed.environment,
        limitations: managed.limitations,
        locations: managed.locations,
        evidenceLinks: managed.evidence_links,
      },
    );

    expect(() =>
      verifyManagedNativeBoundaries({
        ...input,
        managed_boundaries: mismatched,
      }),
    ).toThrow(
      `Managed Evidence inspect_managed_native_boundaries (${mismatched.evidence_id}) subject SHA-256 ${result.artifact.sha256} does not match normalized artifact SHA-256 ${otherDigest}`,
    );
    expect(verifyManagedNativeBoundaries(input).summary.verified).toBe(1);
  });
});

it("verifies a P/Invoke declaration against native export Evidence", () => {
  const result = verifyManagedNativeBoundaries(exampleInput());

  expect(result).toMatchObject({
    managed_boundary: {
      artifact_sha256: "6".repeat(64),
      mvid: "00112233-4455-4677-8899-aabbccddeeff",
      pinvoke_imports_total: 1,
    },
    summary: { verified: 1 },
    pinvoke_imports: [
      {
        managed: {
          import_name: "open_native",
          import_scope_name: "nativehelper.dll",
        },
        status: "verified",
        basis: "exact-export-name",
        confidence: "observed",
        matched_native: { name: "open_native" },
      },
    ],
  });
});

it("treats a Mach-O ABI-prefixed export as an exact declared import", () => {
  const result = verifyManagedNativeBoundaries({
    ...exampleInput(),
    native_observations: [nativeEvidenceWithExports(["_open_native"])],
  });

  expect(result.summary).toMatchObject({ verified: 1, inferred: 0 });
  expect(result.pinvoke_imports[0]).toMatchObject({
    status: "verified",
    basis: "exact-export-name",
    matched_native: { name: "_open_native" },
  });
});

it("reports module mismatch as a contradiction within supplied Evidence", () => {
  const input = exampleInput();
  const native = input.native_observations[0];
  if (native === undefined || native.subject === null)
    throw new Error("missing native example");
  const mismatched = createEvidence(
    {
      path: "/examples/other.dll",
      sha256: native.subject.digest.sha256,
      format: "pe",
      ...(native.subject.architecture === null
        ? {}
        : { architecture: native.subject.architecture }),
    },
    native.provider,
    {
      operation: native.operation,
      parameters: native.parameters,
      result: native.normalized_result,
      rawResult: native.raw_result,
      confidence: native.confidence,
      authority: native.authority,
      environment: native.environment,
      limitations: native.limitations,
      locations: native.locations,
      evidenceLinks: native.evidence_links,
    },
  );

  const result = verifyManagedNativeBoundaries({
    ...input,
    native_observations: [mismatched],
  });

  expect(result.summary).toMatchObject({
    verified: 0,
    contradicted: 1,
  });
  expect(result.pinvoke_imports[0]).toMatchObject({
    status: "contradicted",
    basis: "module-mismatch",
  });
});

it("keeps literal module names distinct and accepts the shared-library lib alias", () => {
  const literalName = verifyManagedNativeBoundaries({
    ...inputWithImportScope("library"),
    native_observations: [
      nativeEvidenceWithExports(["open_native"], "/examples/rary.dylib"),
    ],
  });
  expect(literalName.pinvoke_imports[0]).toMatchObject({
    status: "contradicted",
    basis: "module-mismatch",
    matched_native: { module_path: "/examples/rary.dylib" },
  });

  const sharedLibraryAlias = verifyManagedNativeBoundaries({
    ...inputWithImportScope("foo"),
    native_observations: [
      nativeEvidenceWithExports(["open_native"], "/examples/libfoo.dylib"),
    ],
  });
  expect(sharedLibraryAlias.pinvoke_imports[0]).toMatchObject({
    status: "verified",
    basis: "exact-export-name",
    matched_native: { module_path: "/examples/libfoo.dylib" },
  });
});

it("keeps name candidates unresolved when a required module identity is absent", () => {
  for (const scope of [null, "", "   "]) {
    const result = verifyManagedNativeBoundaries({
      ...inputWithImportScope(scope),
      native_observations: [nativeEvidenceWithExports(["open_native"])],
    });
    expect(result.pinvoke_imports[0]).toMatchObject({
      status: "unresolved",
      basis: "module-identity-unknown",
      matched_native: { name: "open_native" },
      candidates: [{ name: "open_native" }],
    });
    expect(result.pinvoke_imports[0]?.limitations).toContain(
      "A native name candidate exists, but a required module identity is unavailable; module correspondence is unknown.",
    );
  }

  for (const path of [
    "/examples/lib.dylib",
    "/examples/lib.so",
    "/examples/foo.dll",
  ]) {
    const extensionOnly = verifyManagedNativeBoundaries({
      ...inputWithImportScope(".dll"),
      native_observations: [nativeEvidenceWithExports(["open_native"], path)],
    });
    expect(extensionOnly.pinvoke_imports[0]).toMatchObject({
      status: "unresolved",
      basis: "module-identity-unknown",
      candidates: [{ name: "open_native", module_path: path }],
    });
  }

  const subjectless = verifyManagedNativeBoundaries({
    ...inputWithImportScope("nativehelper.dll"),
    native_observations: [
      nativeEvidenceWithExports(["open_native"], undefined, true),
    ],
  });
  expect(subjectless.pinvoke_imports[0]).toMatchObject({
    status: "unresolved",
    basis: "module-identity-unknown",
    matched_native: {
      name: "open_native",
      module_name: null,
      module_path: null,
    },
    candidates: [{ name: "open_native" }],
  });
});

it("treats supported native Evidence with no symbols as unresolved", () => {
  const result = verifyManagedNativeBoundaries({
    ...exampleInput(),
    native_observations: [nativeEvidenceWithExports([])],
  });

  expect(result.native_observations).toMatchObject({
    accepted: 1,
    unsupported: 0,
    symbols: 0,
  });
  expect(result.summary).toMatchObject({
    verified: 0,
    unresolved: 1,
  });
  expect(result.pinvoke_imports[0]).toMatchObject({
    status: "unresolved",
    basis: "no-native-candidate",
  });
});

it("does not verify a symbol whose spelling differs only by case", () => {
  const result = verifyManagedNativeBoundaries({
    ...exampleInput(),
    native_observations: [nativeEvidenceWithExports(["OPEN_NATIVE"])],
  });

  expect(result.summary).toMatchObject({ verified: 0, unresolved: 1 });
  expect(result.pinvoke_imports[0]).toMatchObject({
    status: "unresolved",
    matched_native: null,
    candidates: [],
  });
});

it("retains every observed native candidate", () => {
  const result = verifyManagedNativeBoundaries({
    ...exampleInput(),
    native_observations: [
      nativeEvidenceWithExports(["open_native", "_open_native"]),
    ],
  });

  expect(result.coverage).toMatchObject({
    status: "complete-within-inputs",
  });
  expect(result.pinvoke_imports[0]?.candidates).toHaveLength(2);
});

it("wraps verification in derived workflow Evidence", () => {
  const evidence = verifyManagedNativeBoundariesEvidence(exampleInput());

  if (!evidence.ok) throw evidence.error;
  expect(evidence.value).toMatchObject({
    operation: "verify_managed_native_boundaries",
    provider: { id: "rea-dotnet-workflows" },
    confidence: "inferred",
    authority: "analyst-inference",
    normalized_result: {
      summary: { verified: 1 },
    },
  });
  expect(evidence.value.evidence_links).toHaveLength(2);
});

describe("managed/native verification result algebra", () => {
  it("rejects states without their required native match", () => {
    const result = verifyManagedNativeBoundaries(exampleInput());
    const verification = result.pinvoke_imports[0];
    expect(verification).toBeDefined();
    if (verification === undefined) return;

    expect(
      managedNativeVerificationResultSchema.safeParse({
        ...result,
        pinvoke_imports: [
          {
            ...verification,
            matched_native: null,
            candidates: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      managedNativeVerificationResultSchema.safeParse({
        ...result,
        pinvoke_imports: [
          {
            ...verification,
            status: "unresolved",
            basis: "no-native-candidate",
            confidence: "unknown",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      managedNativeVerificationResultSchema.safeParse({
        ...result,
        coverage: {
          status: "complete-within-inputs",
          omitted_native_observations: 0,
          omitted_candidates: 1,
        },
      }).success,
    ).toBe(false);
  });
});

it("does not erase a C identifier underscore beyond the Mach-O ABI prefix", () => {
  const result = verifyManagedNativeBoundaries({
    ...exampleInput(),
    native_observations: [nativeEvidenceWithExports(["__open_native"])],
  });
  expect(result.summary).toMatchObject({ inferred: 0, unresolved: 1 });
  expect(result.pinvoke_imports[0]).toMatchObject({
    status: "unresolved",
    candidates: [],
    matched_native: null,
  });
});

it("does not treat a raw Mach-O ABI name as an exact underscored C identifier", () => {
  const input = exampleInput();
  const managed = input.managed_boundaries;
  const normalized = managedNativeBoundaryInspectionSchema.parse(
    managed.normalized_result,
  );
  const imports = normalized.pinvoke_imports;
  const result = verifyManagedNativeBoundaries({
    ...input,
    managed_boundaries: createEvidence(undefined, managed.provider, {
      operation: managed.operation,
      parameters: managed.parameters,
      result: {
        ...normalized,
        pinvoke_imports: imports.map((item) => ({
          ...item,
          import_name: "_open_native",
          no_mangle: true,
        })),
      },
      rawResult: null,
    }),
    native_observations: [nativeEvidenceWithExports(["_open_native"])],
  });
  expect(result.summary).toMatchObject({
    verified: 0,
    inferred: 0,
    unresolved: 1,
  });
  expect(result.pinvoke_imports[0]?.candidates).toEqual([]);
});

describe("portable native export inventories", () => {
  /** Managed Evidence declaring each name from `scope`, cloned from the example. */
  const managedImports = (scope: string, names: readonly string[]) => {
    const managed = exampleInput().managed_boundaries;
    const normalized = managedNativeBoundaryInspectionSchema.parse(
      managed.normalized_result,
    );
    const [template] = normalized.pinvoke_imports;
    if (template === undefined) throw new Error("missing P/Invoke example");
    return createEvidence(undefined, managed.provider, {
      operation: managed.operation,
      parameters: managed.parameters,
      result: {
        ...normalized,
        pinvoke_imports: names.map((import_name, index) => ({
          ...template,
          token: `0x1c00000${String(index + 1)}`,
          import_name,
          import_scope_name: scope,
        })),
      },
      rawResult: null,
    });
  };

  const exportEvidence = (path: string, bytes: Buffer) => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const result = parseNativeExports(bytes, {
      path,
      sha256,
      bytes: bytes.length,
    });
    return createEvidence(
      { path, sha256, format: result.format },
      NATIVE_EXPORTS_PROVIDER,
      {
        operation: "inspect_native_exports",
        parameters: { path, max_file_bytes: 268435456 },
        result,
        confidence: "observed",
        limitations: result.limitations,
      },
    );
  };

  const verify = (
    scope: string,
    names: readonly string[],
    native: ReturnType<typeof exportEvidence>,
  ) =>
    new Map(
      verifyManagedNativeBoundaries({
        managed_boundaries: managedImports(scope, names),
        native_observations: [native],
      }).pinvoke_imports.map((item) => [item.managed.import_name, item]),
    );

  it("verifies exact ELF exports and keeps hidden or unread versions inferred", () => {
    const elf = exportEvidence(
      "/native/libfixture.so",
      elfExportImage({
        symbols: [
          { name: "plain_fn" },
          { name: "current_fn", version: 2 },
          { name: "old_fn", version: 0x8003 },
        ],
        versionDefinitions: ["libfixture.so", "V2", "V1"],
      }),
    );
    const results = verify(
      "fixture",
      ["plain_fn", "current_fn", "old_fn", "absent_fn"],
      elf,
    );

    for (const name of ["plain_fn", "current_fn"])
      expect(results.get(name)).toMatchObject({
        status: "verified",
        basis: "exact-export-name",
        matched_native: {
          name,
          source: "elf-export",
          evidence_id: elf.evidence_id,
          module_path: "/native/libfixture.so",
        },
      });
    expect(results.get("old_fn")).toMatchObject({
      status: "inferred",
      basis: "qualified-export-candidate",
      matched_native: { export_qualifier: "non-default-version" },
      limitations: [expect.stringContaining("hidden version")],
    });
    expect(results.get("absent_fn")).toMatchObject({
      status: "unresolved",
      basis: "no-native-candidate",
    });

    const unread = exportEvidence(
      "/native/libfixture.so",
      elfExportImage({
        symbols: [{ name: "plain_fn" }],
        versionDefinitions: ["libfixture.so"],
        truncatedVersions: true,
      }),
    );
    expect(
      verify("fixture", ["plain_fn"], unread).get("plain_fn"),
    ).toMatchObject({
      status: "inferred",
      matched_native: { export_qualifier: "unknown-version" },
    });
  });

  it("verifies named PE exports and keeps forwarders inferred", () => {
    const pe = exportEvidence(
      "/native/fixture.dll",
      peExportImage({
        functions: [
          { rva: 0x2000 },
          { forwarder: "OTHER.Target" },
          { rva: 0x2010 },
        ],
        names: [
          { name: "Primary", index: 0 },
          { name: "Forwarded", index: 1 },
        ],
      }),
    );
    const results = verify("fixture.dll", ["Primary", "Forwarded"], pe);

    expect(results.get("Primary")).toMatchObject({
      status: "verified",
      basis: "exact-export-name",
      matched_native: { source: "pe-export", address: "0x180002000" },
    });
    expect(results.get("Forwarded")).toMatchObject({
      status: "inferred",
      basis: "qualified-export-candidate",
      matched_native: { export_qualifier: "forwarded", address: null },
      limitations: [expect.stringContaining("forwards to another DLL")],
    });
    // A matching name under another module is a contradiction, not a match.
    expect(verify("other.dll", ["Primary"], pe).get("Primary")).toMatchObject({
      status: "contradicted",
      basis: "module-mismatch",
    });
  });
});
