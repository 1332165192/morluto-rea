import { promises as filesystem } from "node:fs";
import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

const analyzeFailure = async (input: Record<string, unknown>) => {
  const result = await analyzeJavaScriptApplication(input);
  if (result.ok) throw new Error("Expected the selection to be refused");
  return projectAnalysisError(result.error);
};

const application = async () => {
  const root = await createTestTempDirectory("rea-javascript-selection-");
  const directory = join(root, "app");
  await mkdir(directory);
  await writeFile(join(directory, "index.js"), "module.exports = 1;\n");
  return { root, directory };
};

describe("JavaScript application input selection", () => {
  it("preserves the selected path and host reason for an overlong name", async () => {
    const { root } = await application();
    const longPath = join(root, "x".repeat(300));

    expect(await analyzeFailure({ input_path: longPath })).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["input_path"],
            reason: "invalid_value",
            message: expect.stringContaining(
              `Selected input path exceeds the host path or component length limit (ENAMETOOLONG): ${longPath}`,
            ),
          },
        ],
      },
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves the selected path when symlink traversal loops or exceeds the host limit",
    async () => {
      const { root } = await application();
      const loopPath = join(root, "loop-a");
      await symlink("loop-b", loopPath);
      await symlink("loop-a", join(root, "loop-b"));
      await writeFile(join(root, "chain-end"), "");
      let target = "chain-end";
      for (let index = 59; index >= 0; index -= 1) {
        const name = `chain-${String(index)}`;
        await symlink(target, join(root, name));
        target = name;
      }
      const chainPath = join(root, "chain-0");

      const loopError = await analyzeFailure({ input_path: loopPath });
      const chainError = await analyzeFailure({ input_path: chainPath });
      const eloopMessage = (path: string) =>
        `Selected input path could not be resolved because symbolic-link traversal looped or exceeded the host limit (ELOOP): ${path}`;
      expect(loopError).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["input_path"],
              reason: "invalid_value",
              message: expect.stringContaining(eloopMessage(loopPath)),
            },
          ],
        },
      });
      expect(chainError).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["input_path"],
              reason: "invalid_value",
              message: expect.stringContaining(eloopMessage(chainPath)),
            },
          ],
        },
      });
      expect(loopError).not.toEqual(chainError);
    },
  );

  it("reports a missing input path as invalid input, not an artifact read failure", async () => {
    const { root } = await application();
    const missing = join(root, "missing");

    expect(await analyzeFailure({ input_path: missing })).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        issues: [
          {
            path: ["input_path"],
            reason: "invalid_value",
            message: expect.stringContaining(missing),
          },
        ],
      },
    });
  });

  it("reports a file that is neither a directory nor an .asar as an unsupported target", async () => {
    const { root } = await application();
    const binary = join(root, "program");
    await writeFile(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));

    expect(await analyzeFailure({ input_path: binary })).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
      remediation: { action: expect.stringContaining(".asar") },
      details: {
        operation: "analyze_javascript_application",
        path: binary,
      },
    });
  });

  it.each([
    ["a directory", "directory", "asar"],
    ["an .asar file", "asar", "directory"],
  ] as const)(
    "reports %s selected with a contradicting format as an invalid request",
    async (_label, observed, format) => {
      const { root, directory } = await application();
      const selected =
        observed === "directory" ? directory : join(root, "app.asar");
      if (observed === "asar") await writeFile(selected, "not inspected");

      expect(
        await analyzeFailure({ input_path: selected, format }),
      ).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["format"],
              reason: "invalid_value",
              expected: ["auto", observed],
            },
          ],
        },
      });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable selected directory as a host access denial",
    async () => {
      const { directory } = await application();
      await chmod(directory, 0o000);
      onTestFinished(() => chmod(directory, 0o700));

      expect(await analyzeFailure({ input_path: directory })).toMatchObject({
        code: "access_denied",
        details: { path: directory, system_code: "EACCES" },
      });
    },
  );
});

describe("JavaScript application selected directory search permission", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a readable but unsearchable selected directory as a host access denial",
    async () => {
      const { directory } = await application();
      await chmod(directory, 0o400);
      try {
        expect(await analyzeFailure({ input_path: directory })).toMatchObject({
          code: "access_denied",
          category: "unavailable",
          details: {
            path: directory,
            system_code: "EACCES",
            boundary: "filesystem-read",
          },
        });
      } finally {
        await chmod(directory, 0o700);
      }
      expect(
        (await analyzeJavaScriptApplication({ input_path: directory })).ok,
      ).toBe(true);
    },
  );
});

describe("JavaScript application host filesystem failures", () => {
  const inject = async (
    method: "access" | "lstat" | "realpath",
    selected: string,
    failure: Error,
  ) => {
    const original = filesystem[method] as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let injected = 0;
    const spy = vi.spyOn(filesystem, method).mockImplementation((async (
      ...args: unknown[]
    ) => {
      if (String(args[0]) === selected) {
        injected += 1;
        throw failure;
      }
      return original(...args);
    }) as never);
    syncBuiltinESMExports();
    try {
      const error = await analyzeFailure({ input_path: selected });
      expect(injected).toBe(1);
      return error;
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  };

  const hostFailure = (code: string, syscall: string, path: string) =>
    Object.assign(new Error(`${code}: host failure, ${syscall} '${path}'`), {
      code,
      syscall,
      path,
    });

  it("keeps the errno, syscall and path of a host I/O failure", async () => {
    const { directory } = await application();
    const selected = await realpath(directory);
    const failure = hostFailure("EIO", "realpath", selected);

    expect(await inject("realpath", selected, failure)).toMatchObject({
      code: "artifact_operation_failed",
      category: "execution_failure",
      details: {
        operation: "analyze_javascript_application",
        reason: "io",
        detail: failure.message,
        diagnostics: {
          system_code: "EIO",
          syscall: "realpath",
          path: selected,
        },
      },
    });
  });

  it("reports descriptor exhaustion as a retryable resource constraint", async () => {
    const { directory } = await application();
    const selected = await realpath(directory);

    expect(
      await inject(
        "access",
        selected,
        hostFailure("EMFILE", "access", selected),
      ),
    ).toMatchObject({
      code: "resource_constraint",
      category: "resource_constraint",
      retryable: true,
      details: {
        operation: "analyze_javascript_application",
        resource: "capacity",
        reported_limits: {
          system_code: "EMFILE",
          syscall: "access",
          path: selected,
        },
      },
    });
  });

  it("classifies a denied selected metadata read as a host access denial", async () => {
    const { directory } = await application();
    const selected = await realpath(directory);

    expect(
      await inject("lstat", selected, hostFailure("EACCES", "lstat", selected)),
    ).toMatchObject({
      code: "access_denied",
      details: { path: selected, system_code: "EACCES" },
    });
  });

  it("keeps a non-errno failure an execution failure", async () => {
    const { directory } = await application();
    const selected = await realpath(directory);

    expect(
      await inject("lstat", selected, new Error("unexpected internal failure")),
    ).toMatchObject({
      code: "execution_failure",
      category: "execution_failure",
      details: {
        diagnostics: { error_message: "unexpected internal failure" },
      },
    });
  });
});
