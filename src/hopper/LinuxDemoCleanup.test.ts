import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { expect, it, vi } from "vitest";

import type { OwnedProcessGroup } from "../process/ProcessOwnership.js";
import type { ProviderProcessHandle } from "../process/ProviderProcess.js";
import { createLinuxDemoCleanup } from "./LinuxDemoCleanup.js";

class FixtureHelper extends EventEmitter implements ProviderProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 901;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }
}

const fixtureOwnership = {
  runId: "linux-demo-cleanup-test",
  leaderPid: 901,
  processGroupId: 901,
} satisfies OwnedProcessGroup;

it("sends stdin EOF once and does not restart the grace period on cleanup retry", async () => {
  const helper = new FixtureHelper();
  const end = vi.spyOn(helper.stdin, "end");
  let now = 0;
  const waits: number[] = [];
  const groupCleanup = vi
    .fn()
    .mockResolvedValueOnce({ cleaned: false, reason: "retry required" })
    .mockResolvedValueOnce({ cleaned: true, signaled: true });
  const cleanup = createLinuxDemoCleanup(helper, fixtureOwnership, 100, {
    cleanupGroup: groupCleanup,
    now: () => now,
    waitForExit: async (_helper, timeoutMs) => {
      waits.push(timeoutMs);
    },
  });

  await expect(cleanup()).resolves.toMatchObject({ cleaned: false });
  now = 100;
  await expect(cleanup()).resolves.toMatchObject({ cleaned: true });

  expect(waits).toEqual([100, 0]);
  expect(end).toHaveBeenCalledOnce();
  expect(groupCleanup).toHaveBeenCalledTimes(2);
});

it("does not wait for orderly shutdown after the helper has already exited", async () => {
  const helper = new FixtureHelper();
  helper.exitCode = 0;
  helper.emit("exit", 0, null);
  const end = vi.spyOn(helper.stdin, "end");
  const groupCleanup = vi
    .fn()
    .mockResolvedValue({ cleaned: true, signaled: false });
  const cleanup = createLinuxDemoCleanup(helper, fixtureOwnership, 10_000, {
    cleanupGroup: groupCleanup,
  });

  await expect(cleanup()).resolves.toMatchObject({ cleaned: true });
  expect(end).not.toHaveBeenCalled();
  expect(groupCleanup).toHaveBeenCalledOnce();
});
