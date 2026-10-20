import type {
  OwnedProcessGroup,
  ProcessCleanupResult,
} from "../process/ProcessOwnership.js";
import type { ProviderProcessHandle } from "../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";

export const LINUX_DEMO_ORDERLY_SHUTDOWN_GRACE_MS = 10_000;

interface LinuxDemoCleanupOptions {
  readonly cleanupGroup?: (
    ownership: OwnedProcessGroup,
  ) => Promise<ProcessCleanupResult>;
  readonly now?: () => number;
  readonly waitForExit?: typeof waitForHelperExit;
}

/** Keep one orderly-shutdown request and deadline across supervisor retries. */
export const createLinuxDemoCleanup = (
  helper: ProviderProcessHandle,
  ownership: OwnedProcessGroup,
  orderlyShutdownGraceMs: number,
  options: LinuxDemoCleanupOptions = {},
): (() => Promise<ProcessCleanupResult>) => {
  const cleanupGroup = options.cleanupGroup ?? cleanupOwnedProcessGroup;
  const now = options.now ?? (() => performance.now());
  const waitForExit = options.waitForExit ?? waitForHelperExit;
  let deadline: number | undefined;
  let orderlyShutdownRequested = false;

  return async () => {
    if (deadline === undefined) {
      deadline = now() + Math.max(0, orderlyShutdownGraceMs);
      const stdin = helper.stdin;
      if (
        helper.exitCode === null &&
        helper.signalCode === null &&
        stdin !== undefined &&
        stdin !== null
      ) {
        orderlyShutdownRequested = true;
        try {
          stdin.end();
        } catch {
          // Process-group cleanup below remains the verified fallback.
        }
      }
    }

    if (
      orderlyShutdownRequested &&
      helper.exitCode === null &&
      helper.signalCode === null
    )
      await waitForExit(helper, Math.max(0, deadline - now()));

    return cleanupGroup(ownership);
  };
};

const waitForHelperExit = (
  helper: ProviderProcessHandle,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve) => {
    if (helper.exitCode !== null || helper.signalCode !== null)
      return resolve();
    const timer = setTimeout(() => {
      helper.off("exit", onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    helper.once("exit", onExit);
  });
