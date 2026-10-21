import { access } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";

import { expect, it, vi } from "vitest";

import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import type { BridgeLauncher } from "../../../../src/hopper/BridgeLauncher.js";
import {
  HopperCancelledError,
  HopperProcessError,
} from "../../../../src/domain/hopperErrors.js";
import { ok } from "../../../../src/domain/result.js";
import { ProviderRunLineage } from "../../../../src/process/ProviderRunLineage.js";
import { waitForExit } from "../../../support/process/processFixture.js";
import {
  HopperFixtureLauncher,
  trackHopperClient,
} from "./hopperClient.fixture.js";

const ownedChildLauncher = (
  source: string,
  onSpawn?: (child: ChildProcess, sessionDirectory: string) => void,
): BridgeLauncher => ({
  async launch(session) {
    const child = spawn(process.execPath, ["-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    onSpawn?.(child, session.directory);
    return ok({
      process: child,
      ownsProcessLifetime: true,
      providerLifetime: "launcher-process",
      shutdownMode: "process-cleanup",
      cleanup: async () => {
        const signaled = child.exitCode === null && child.signalCode === null;
        if (signaled) child.kill("SIGTERM");
        return (await waitForExit(child, 5_000))
          ? { cleaned: true as const, signaled }
          : {
              cleaned: false as const,
              reason: "Fixture child did not exit",
            };
      },
    });
  },
});

it("keeps an owned launcher exit observed before abort as the startup failure", async () => {
  const controller = new AbortController();
  const abortReason = new Error("caller aborted after observed launcher exit");
  let ownedChild: ChildProcess | undefined;
  let runtimeDirectory: string | undefined;
  let observeExit!: () => void;
  const exitObserved = new Promise<void>((resolve) => {
    observeExit = resolve;
  });
  const client = trackHopperClient(
    new HopperClient({
      startupTimeoutMs: 10_000,
      launcher: ownedChildLauncher("process.exit(3)", (child, directory) => {
        ownedChild = child;
        runtimeDirectory = directory;
      }),
      onDiagnostic: (event) => {
        if (event.type !== "launcher-exit") return;
        observeExit();
        setImmediate(() => controller.abort(abortReason));
      },
    }),
  );

  try {
    const started = await client.start(controller.signal);
    await exitObserved;
    expect(controller.signal.reason).toBe(abortReason);
    expect(started).toMatchObject({
      ok: false,
      error: {
        _tag: "HopperProcessError",
        exitCode: 3,
        stage: "launch",
      },
    });
    if (started.ok) throw new Error("Expected the owned launcher failure");
    if (!(started.error instanceof HopperProcessError))
      throw new Error("Expected HopperProcessError");
    expect(started.error.cleanupIncomplete).toBe(false);
    expect(started.error.launcherFailure).toMatchObject({ exit_code: 3 });
    if (ownedChild === undefined) throw new Error("Missing owned launcher");
    expect(await waitForExit(ownedChild, 5_000)).toBe(true);
    expect(ownedChild.exitCode).toBe(3);
    if (runtimeDirectory === undefined)
      throw new Error("Missing owned runtime directory");
    await expect(access(runtimeDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await client.close();
  }

  const control = trackHopperClient(
    new HopperClient({
      startupTimeoutMs: 10_000,
      launcher: ownedChildLauncher("process.exit(3)"),
    }),
  );
  try {
    const started = await control.start();
    expect(started).toMatchObject({
      ok: false,
      error: { _tag: "HopperProcessError", exitCode: 3, stage: "launch" },
    });
  } finally {
    await control.close();
  }
});

it("preserves the exact caller reason when cancellation precedes launcher exit", async () => {
  const controller = new AbortController();
  const abortReason = new Error("caller cancelled before launcher exit");
  let launchChild!: () => void;
  let runtimeDirectory: string | undefined;
  const childLaunched = new Promise<void>((resolve) => {
    launchChild = resolve;
  });
  const client = trackHopperClient(
    new HopperClient({
      startupTimeoutMs: 10_000,
      launcher: ownedChildLauncher(
        'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);',
        (_child, directory) => {
          runtimeDirectory = directory;
          launchChild();
        },
      ),
    }),
  );

  try {
    const starting = client.start(controller.signal);
    await childLaunched;
    controller.abort(abortReason);
    const started = await starting;
    expect(started).toMatchObject({
      ok: false,
      error: { _tag: "HopperCancelledError", cause: abortReason },
    });
    if (started.ok) throw new Error("Expected caller cancellation");
    expect(started.error).toBeInstanceOf(HopperCancelledError);
    expect(started.error.cause).toBe(abortReason);
    if (runtimeDirectory === undefined)
      throw new Error("Missing owned runtime directory");
    await expect(access(runtimeDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await client.close();
  }
});

it("preserves a warm provider when an already cancelled caller joins", async () => {
  const launcher = new HopperFixtureLauncher();
  const client = trackHopperClient(new HopperClient({ launcher }));
  await expect(client.start()).resolves.toMatchObject({ ok: true });
  const controller = new AbortController();
  controller.abort();
  await expect(client.start(controller.signal)).resolves.toMatchObject({
    ok: false,
    error: { _tag: "HopperCancelledError" },
  });
  expect(client.isReady()).toBe(true);
  expect(client.operationHealth()).toMatchObject({ state: "idle" });
  await expect(
    client.callTool("echo", { value: "live caller" }),
  ).resolves.toEqual({
    ok: true,
    value: { value: "live caller" },
  });
  expect(launcher.processes).toHaveLength(1);
});

it("reports provider closure to live startup callers without cancelling their signals", async () => {
  const launcher = new HopperFixtureLauncher(undefined, "quiet", "gated");
  const client = trackHopperClient(
    new HopperClient({ launcher, startupTimeoutMs: 10_000 }),
  );
  const first = new AbortController();
  const second = new AbortController();
  const waits = [client.start(first.signal), client.start(second.signal)];
  await launcher.waitForRequest("health");
  await expect(client.close()).resolves.toEqual({ ok: true, value: null });
  for (const waiting of waits)
    await expect(waiting).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "HopperProtocolError",
        message: "Hopper session closed during startup",
      },
    });
  expect(first.signal.aborted).toBe(false);
  expect(second.signal.aborted).toBe(false);
  expect(client.isReady()).toBe(false);
});

it("retains the final caller's cleanup failure and blocks replacement until close succeeds", async () => {
  const fixture = new HopperFixtureLauncher();
  const controller = new AbortController();
  let allowCleanup = false;
  const client = trackHopperClient(
    new HopperClient({
      startupTimeoutMs: 10_000,
      launcher: {
        async launch(session) {
          const launched = await fixture.launch(session);
          if (!launched.ok) return launched;
          if (fixture.processes.length === 1) controller.abort();
          return ok({
            ...launched.value,
            cleanup: async () =>
              allowCleanup
                ? launched.value.cleanup()
                : { cleaned: false as const, reason: "Fixture cleanup denied" },
          });
        },
      },
    }),
  );
  try {
    const first = await client.start(controller.signal);
    expect(first).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    if (first.ok) throw new Error("Expected retained cleanup");
    const retry = await client.start();
    if (retry.ok) throw new Error("Unexpected replacement startup");
    expect(retry.error).toBe(first.error);
    expect(fixture.processes).toHaveLength(1);
    await expect(access(fixture.directories[0] ?? "")).resolves.toBeUndefined();
    allowCleanup = true;
    await expect(client.close()).resolves.toEqual({ ok: true, value: null });
    await expect(access(fixture.directories[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(client.start()).resolves.toMatchObject({ ok: true });
    expect(fixture.processes).toHaveLength(2);
  } finally {
    allowCleanup = true;
    await client.close();
  }
});

it.each([0, 1])(
  "cancels Hopper startup caller %s independently of its peer",
  async (cancelledIndex) => {
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const launchPending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const launchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launcher = new HopperFixtureLauncher();
    const client = trackHopperClient(
      new HopperClient({
        startupTimeoutMs: 10_000,
        launcher: {
          async launch(session) {
            entered?.();
            await launchGate;
            return launcher.launch(session);
          },
        },
      }),
    );
    const controllers = [new AbortController(), new AbortController()];
    const waits = controllers.map(({ signal }) =>
      client.callTool("echo", { value: "live peer" }, { signal }),
    );
    try {
      await launchPending;
      let cancelled: Awaited<ReturnType<HopperClient["callTool"]>> | undefined;
      void waits[cancelledIndex]?.then((result) => {
        cancelled = result;
      });
      controllers[cancelledIndex]?.abort();
      await vi.waitFor(() =>
        expect(cancelled).toMatchObject({
          ok: false,
          error: { _tag: "HopperCancelledError" },
        }),
      );
      expect(launcher.processes).toHaveLength(0);
      release?.();
      await expect(waits[1 - cancelledIndex]).resolves.toMatchObject({
        ok: true,
        value: { value: "live peer" },
      });
      expect(launcher.processes).toHaveLength(1);
      expect(client.isReady()).toBe(true);
    } finally {
      release?.();
      await Promise.all(waits);
    }
  },
);

it.each(["cancelled", "rejected"] as const)(
  "owns Hopper final startup cleanup when lineage is %s",
  async (stage) => {
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cause = new TypeError("Lineage reader rejected");
    const original = ProviderRunLineage.prototype.observe;
    const observe = vi.spyOn(ProviderRunLineage.prototype, "observe");
    observe.mockImplementationOnce(async function (
      this: ProviderRunLineage,
      launch,
    ) {
      entered?.();
      await gate;
      if (stage === "rejected") throw cause;
      await original.call(this, launch);
    });
    const launcher = new HopperFixtureLauncher();
    const client = trackHopperClient(
      new HopperClient({ launcher, startupTimeoutMs: 10_000 }),
    );
    const controller = new AbortController();
    const starting = client.start(controller.signal);
    try {
      await pending;
      if (stage === "cancelled") controller.abort();
      release?.();
      const result = await starting;
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag:
            stage === "cancelled" ? "HopperCancelledError" : "HopperStartError",
        },
      });
      if (result.ok) throw new Error("Expected interrupted startup");
      if (stage === "rejected") expect(result.error.cause).toBe(cause);
      const child = launcher.processes[0];
      if (child === undefined) throw new Error("Missing fixture process");
      expect(await waitForExit(child, 5_000)).toBe(true);
      await expect(access(launcher.directories[0] ?? "")).rejects.toMatchObject(
        { code: "ENOENT" },
      );
      expect(client.isReady()).toBe(false);
      await expect(client.start()).resolves.toMatchObject({ ok: true });
      expect(launcher.processes).toHaveLength(2);
    } finally {
      release?.();
      observe.mockRestore();
      await starting.catch(() => undefined);
    }
  },
);

it("keeps an unstarted client reusable after an already cancelled startup wait", async () => {
  const launcher = new HopperFixtureLauncher();
  const client = trackHopperClient(
    new HopperClient({ launcher, startupTimeoutMs: 30_000 }),
  );
  const controller = new AbortController();
  controller.abort();

  const result = await client.start(controller.signal);

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("HopperCancelledError");
  expect(launcher.processes).toHaveLength(0);
  expect(client.isReady()).toBe(false);
  expect(client.operationHealth()).toMatchObject({ state: "idle" });
  await expect(
    client.callTool("echo", { value: "live caller" }),
  ).resolves.toEqual({
    ok: true,
    value: { value: "live caller" },
  });
  expect(launcher.processes).toHaveLength(1);
  expect(client.isReady()).toBe(true);
});
