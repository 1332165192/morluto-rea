import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
  type ProcessIdentityObservation,
  type ProcessOwnershipHost,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "./ProcessOwnershipEvidence.js";

const row = (pid: number, parentPid: number): ProcessTableEntry => ({
  pid,
  parentPid,
  processGroupId: pid,
  state: "R",
  command: "/fixture/node",
});
const identity = (
  process: ProcessTableEntry,
  exiting: boolean,
): ProcessIdentityObservation => ({
  state: "readable",
  identity: `start:${process.pid}`,
  lifecycle: {
    state: "observed",
    lifecycle: exiting ? "exiting" : "non-zombie",
  },
  relation: {
    state: "observed",
    parentPid: process.parentPid,
    processGroupId: process.processGroupId,
  },
});

it("retains a live token-cleared child when its verified parent exits during observation", async () => {
  const parent = row(200, 1);
  const child = row(300, parent.pid);
  const owner = new ProcessOwnershipEvidenceOwner();
  let parentReads = 0;
  const host: ProcessOwnershipHost = {
    listProcesses: async () => [parent, child],
    environment: async (pid) =>
      pid === parent.pid ? { REA_PROCESS_RUN_ID: "run" } : {},
    processIdentities: async (rows) =>
      new Map<number, ProcessIdentityObservation>(
        rows.map((process) => [
          process.pid,
          process.pid === parent.pid && ++parentReads > 2
            ? { state: "absent" as const, reason: "not-in-snapshot" }
            : identity(
                process,
                process.pid === parent.pid && parentReads === 2,
              ),
        ]),
      ),
    signalGroup: vi.fn(),
  };
  const result = await verifyNoTokenOwnedProcesses("run", host, undefined, {
    leaderPid: 100,
    processGroupId: 100,
    evidenceOwner: owner,
  });
  // The fixture's child never exited or changed generation. Its previously
  // observed parent edge must survive the parent's later terminal observation.
  expect(result.cleaned).toBe(false);
  expect(owner.candidates).toContainEqual(
    expect.objectContaining({
      pid: child.pid,
      identity: "start:300",
      applicability: "related-ownership-unresolved",
    }),
  );
  expect(host.signalGroup).not.toHaveBeenCalled();
});

it("shares native exit waiting before signaling healthy groups in one cleanup attempt", async () => {
  const root = row(100, 1);
  const rows = [
    root,
    row(200, root.pid),
    row(300, root.pid),
    row(400, root.pid),
  ];
  let clock = 0;
  let firstSignalAt: number | undefined;
  const nativeClock = vi
    .spyOn(performance, "now")
    .mockImplementation(() => clock);
  const host: ProcessOwnershipHost = {
    listProcesses: async () => rows,
    environment: async () => ({ REA_PROCESS_RUN_ID: "run" }),
    processIdentities: async (selected) => {
      clock += 25;
      return new Map<number, ProcessIdentityObservation>(
        selected.map((process) => [
          process.pid,
          identity(process, process.pid !== root.pid),
        ]),
      );
    },
    signalGroup: vi.fn((group) => {
      expect(group).toBe(root.pid);
      firstSignalAt ??= clock;
    }),
  };
  try {
    const result = await cleanupOwnedProcessGroup(
      {
        runId: "run",
        leaderPid: root.pid,
        processGroupId: root.pid,
        sweepTokenOwnedProcesses: true,
        evidenceOwner: new ProcessOwnershipEvidenceOwner(),
      },
      host,
    );
    expect(result.cleaned).toBe(false);
    expect(firstSignalAt).toBeDefined();
    // Controlled native-observation time, not a wall-clock timeout: three
    // stuck helpers must not each add another full second before root signal.
    expect(firstSignalAt).toBeLessThan(2_000);
  } finally {
    nativeClock.mockRestore();
  }
});
