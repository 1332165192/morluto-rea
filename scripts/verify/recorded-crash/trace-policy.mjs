import assert from "node:assert/strict";

/** Identify REA's Node processes and their observed CLONE_THREAD children. */
export function nodeInventoryThreads(traces, executable) {
  const executesForeign = (text) =>
    text
      .split("\n")
      .some(
        (line) =>
          /^execve\(/u.test(line) &&
          line.endsWith(" = 0") &&
          !line.startsWith(`execve(${JSON.stringify(executable)},`),
      );
  const byPid = new Map(traces.map((trace) => [trace.pid, trace]));
  const nodes = new Set(
    traces
      .filter(
        ({ text }) =>
          !executesForeign(text) &&
          text
            .split("\n")
            .some(
              (line) =>
                line.startsWith(`execve(${JSON.stringify(executable)},`) &&
                line.endsWith(" = 0"),
            ),
      )
      .map(({ pid }) => pid),
  );
  for (const pid of nodes) {
    let pendingThreadClone = false;
    for (const line of byPid.get(pid)?.text.split("\n") ?? []) {
      if (!/^(?:clone3?\(|<\.\.\. clone3? resumed>)/u.test(line)) continue;
      if (/^clone3?\(/u.test(line))
        pendingThreadClone = /\bCLONE_THREAD\b/u.test(line);
      const child = / = (\d+)$/u.exec(line);
      if (pendingThreadClone && child !== null) {
        const childPid = Number(child[1]);
        const trace = byPid.get(childPid);
        if (trace !== undefined && !executesForeign(trace.text))
          nodes.add(childPid);
      }
      if (!line.endsWith("<unfinished ...>")) pendingThreadClone = false;
    }
  }
  return nodes;
}

/** Permit only observed inventory metadata; an unlisted historical PID permits no lookup. */
export function assertHistoricalPidReads({
  trace,
  historicalPid,
  nodeThreads,
  liveCollision,
  psInventory,
}) {
  const reads = trace.text
    .split("\n")
    .filter((line) => line.includes(`/proc/${historicalPid}/`));
  for (const line of reads) {
    const nodeStat =
      nodeThreads.has(trace.pid) &&
      new RegExp(
        `^openat\\([^,]+, "/proc/${historicalPid}/stat", O_RDONLY(?:\\|O_CLOEXEC)?\\)`,
        "u",
      ).test(line);
    const psMetadata =
      psInventory &&
      new RegExp(
        `/proc/${historicalPid}/(?:stat|status|cmdline|wchan|environ)"`,
        "u",
      ).test(line);
    assert.ok(
      liveCollision && (nodeStat || psMetadata),
      `Historical PID caused a non-inventory lookup in trace ${trace.pid}: ${line}`,
    );
  }
  return reads;
}
