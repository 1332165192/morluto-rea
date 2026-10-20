import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { expect, it, onTestFinished, vi } from "vitest";

import { ok } from "../../../../src/domain/result.js";
import type {
  BridgeLaunch,
  BridgeLauncher,
  BridgeSession,
} from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import { createLinuxDemoCleanup } from "../../../../src/hopper/LinuxDemoCleanup.js";
import type { OwnedProcessGroup } from "../../../../src/process/ProcessOwnership.js";
import type { ProviderProcessHandle } from "../../../../src/process/ProviderProcess.js";

class FixtureHelper extends EventEmitter implements ProviderProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 902;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }

  exit(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 0, null);
  }
}

const fixtureOwnership = {
  runId: "linux-demo-client-cleanup-test",
  leaderPid: 902,
  processGroupId: 902,
} satisfies OwnedProcessGroup;

class CancelCleanupLauncher implements BridgeLauncher {
  readonly helper = new FixtureHelper();
  #launchReady: (() => void) | undefined;
  readonly launched: Promise<void>;
  readonly cleanupGroup = vi
    .fn()
    .mockResolvedValueOnce({
      cleaned: false as const,
      reason: "fixture cleanup needs retry",
    })
    .mockResolvedValueOnce({ cleaned: true as const, signaled: false });

  constructor() {
    this.launched = new Promise<void>((resolve) => {
      this.#launchReady = resolve;
    });
  }

  async launch(_session: BridgeSession) {
    const launch: BridgeLaunch = {
      process: this.helper,
      ownsProcessLifetime: true,
      providerLifetime: "launcher-process",
      shutdownMode: "process-cleanup",
      ownership: fixtureOwnership,
      cleanup: createLinuxDemoCleanup(this.helper, fixtureOwnership, 10_000, {
        cleanupGroup: async () => this.cleanupGroup(),
      }),
    };
    this.#launchReady?.();
    return Promise.resolve(ok(launch));
  }
}

it("awaits cancellation-triggered final cleanup and retries the same retained owner", async () => {
  const launcher = new CancelCleanupLauncher();
  const client = new HopperClient({ launcher, startupTimeoutMs: 30_000 });
  onTestFinished(async () => {
    launcher.helper.exit();
    await client.close();
  });

  const controller = new AbortController();
  const starting = client.start(controller.signal);
  await launcher.launched;
  // The client has attached its production supervisor before reaching connect.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(launcher.helper.listenerCount("exit")).toBeGreaterThan(0);
  controller.abort(new Error("fixture caller cancellation"));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("stdin EOF was not sent")),
      2_000,
    );
    launcher.helper.stdin.once("finish", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  let settled = false;
  void starting.finally(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  // The orderly helper exit completes the first cleanup attempt, which is
  // deliberately unresolved at the group boundary. Startup must retain the
  // cancellation as primary while keeping this owner for close() to retry.
  launcher.helper.exit();
  const failed = await starting;
  expect(failed).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      cleanupIncomplete: true,
      cause: { cause: { _tag: "HopperCancelledError" } },
    },
  });

  await expect(client.close()).resolves.toMatchObject({ ok: true });
  expect(launcher.cleanupGroup).toHaveBeenCalledTimes(2);
});
