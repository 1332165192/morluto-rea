import { execFile } from "node:child_process";
import { access, chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const posixTest = cliTest.skipIf(process.platform === "win32");

const idaDoctor = async (cli: TestCli, home: string, registration: string) => {
  const result = await cli.run({
    arguments: ["doctor", "--provider", "ida", "--json"],
    environment: {
      HOME: home,
      REA_LOG_LEVEL: "silent",
      GHIDRA_INSTALL_DIR: join(home, "missing-ghidra"),
      HOPPER_LAUNCHER_PATH: join(home, "missing-hopper"),
      REA_IDA_MCP_CONFIG: registration,
    },
    // A doctor waiting on a FIFO producer never finishes on its own.
    timeoutMs: 15_000,
  });
  const report = result.json as {
    readonly healthy: boolean;
    readonly providerInspections: readonly {
      readonly id: string;
      readonly available: boolean;
      readonly checks: readonly unknown[];
    }[];
  };
  return {
    exitCode: result.exitCode,
    healthy: report.healthy,
    ida: report.providerInspections.find(({ id }) => id === "ida"),
  };
};

posixTest(
  "rejects a FIFO registration without waiting for a writer",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-ida-doctor-fifo-");
    const registration = join(home, "registration.json");
    await promisify(execFile)("mkfifo", [registration]);

    expect(await idaDoctor(cli, home, registration)).toMatchObject({
      exitCode: 1,
      healthy: false,
      ida: {
        available: false,
        checks: [
          {
            name: "registration",
            ok: false,
            code: "invalid_configuration",
            detail: expect.stringContaining("regular JSON file"),
            remediation: expect.stringContaining("REA_IDA_MCP_CONFIG"),
          },
        ],
      },
    });
  },
);

posixTest(
  "reports an unusable headless workspaceRoot without creating it",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-ida-doctor-root-");
    const file = join(home, "file");
    await writeFile(file, "fixture");
    const missing = join(home, "missing");
    const readOnly = join(home, "read-only");
    await mkdir(readOnly);
    await chmod(readOnly, 0o500);
    const writable = join(home, "writable");
    await mkdir(writable);
    // Privileged users bypass directory permission bits, as mkdtemp would.
    const privileged = process.getuid?.() === 0;

    const cases = [
      [file, false],
      [missing, false],
      [readOnly, privileged],
      [writable, true],
      [undefined, true],
    ] as const;
    for (const [index, [workspaceRoot, ready]] of cases.entries()) {
      const registration = join(home, `registration-${index}.json`);
      await writeFile(
        registration,
        JSON.stringify({
          command: join(home, "never-launched"),
          args: [],
          mode: "headless",
          ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        }),
      );
      expect(
        await idaDoctor(cli, home, registration),
        workspaceRoot,
      ).toMatchObject({
        exitCode: ready ? 0 : 1,
        healthy: ready,
        ida: {
          available: ready,
          checks: [
            { name: "registration", ok: true },
            ready
              ? { name: "private_workspace", ok: true, code: null }
              : {
                  name: "private_workspace",
                  ok: false,
                  code: "invalid_configuration",
                  detail: expect.stringContaining(
                    `IDA workspaceRoot ${workspaceRoot}`,
                  ),
                  remediation: expect.stringContaining("workspaceRoot"),
                  classification: "config_drift",
                },
          ],
        },
      });
    }
    // Diagnosis neither creates the missing parent nor allocates workspaces.
    await expect(access(missing)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(writable)).toEqual([]);
  },
);
