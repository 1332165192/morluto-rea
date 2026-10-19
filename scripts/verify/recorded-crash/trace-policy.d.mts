export interface SyscallTrace {
  readonly pid: number;
  readonly text: string;
}
export function nodeInventoryThreads(
  traces: readonly SyscallTrace[],
  executable: string,
): ReadonlySet<number>;
export function assertHistoricalPidAccess(input: {
  readonly trace: SyscallTrace;
  readonly historicalPid: number;
  readonly nodeThreads: ReadonlySet<number>;
  readonly liveCollision: boolean;
  readonly psInventory: boolean;
}): readonly string[];
