import assert from "node:assert/strict";
import { posix } from "node:path";

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

const targetsHistoricalPid = (line, pid) => {
  const first = /^(kill|tkill|rt_sigqueueinfo|pidfd_open)\((-?\d+),/u.exec(
    line,
  );
  if (first !== null) {
    const target = Number(first[2]);
    if (target === pid) return true;
    if (first[1] === "kill" && (target === -pid || target === -1)) return true;
  }
  const pair = /^(?:tgkill|rt_tgsigqueueinfo)\((-?\d+), (-?\d+),/u.exec(line);
  if (pair !== null && (Number(pair[1]) === pid || Number(pair[2]) === pid))
    return true;
  // With -yy the producer supplies the actual pidfd target. An undecoded
  // pidfd control cannot establish that it excludes the historical process.
  return (
    /^(?:pidfd_send_signal|pidfd_getfd)\(/u.test(line) &&
    (!/<pid:\d+>/u.test(line) || line.includes(`<pid:${pid}>`))
  );
};

const readsMetadata = (line, root, names) => {
  const path = `${root}/(?:${names.join("|")})`;
  return (
    new RegExp(
      `^openat\\([^,]+, "${path}", O_RDONLY(?:\\|O_CLOEXEC)?\\)`,
      "u",
    ).test(line) ||
    new RegExp(
      `^statx\\(\\d+<${path}>, "", [^,]*\\bAT_EMPTY_PATH\\b`,
      "u",
    ).test(line) ||
    new RegExp(`^fstat(?:64)?\\(\\d+<${path}>,`, "u").test(line)
  );
};

/** Permit only observed inventory reads; PID-directory handles and controls never qualify. */
export function assertHistoricalPidAccess({
  trace,
  historicalPid,
  nodeThreads,
  liveCollision,
  psInventory,
}) {
  const root = `/proc/${historicalPid}`;
  const pathReference = new RegExp(`${root}(?=[/">]|$)`, "u");
  const accesses = trace.text.split("\n").filter((line) => {
    if (pathReference.test(line) || targetsHistoricalPid(line, historicalPid))
      return true;
    // strace prints the ASCII /proc, PID and dot segments literally. Keep the
    // original line as evidence while recognizing lexical path aliases too.
    for (const quoted of line.matchAll(/"((?:[^"\\]|\\.)*)"/gu))
      if (
        quoted[1].startsWith("/proc/") &&
        pathReference.test(posix.normalize(quoted[1]))
      )
        return true;
    // -yy owns the current dirfd identity, including descriptor reuse. Resolve
    // each FD/path argument pair, not just openat: failed readlinkat, statx and
    // newfstatat attempts have no returned descriptor to reveal their target.
    for (const relative of line.matchAll(
      /(?:\(|, )(?:-?\d+|AT_FDCWD)<(\/[^>]*)>, ("(?:[^"\\]|\\.)*")/gu,
    )) {
      let pathname;
      try {
        pathname = JSON.parse(relative[2]);
      } catch {
        assert.fail(`Unresolved FD-relative pathname: ${line}`);
      }
      const path = posix.resolve(relative[1], pathname);
      if (path === root || path.startsWith(`${root}/`)) return true;
    }
    return false;
  });
  for (const line of accesses) {
    const nodeStat =
      nodeThreads.has(trace.pid) && readsMetadata(line, root, ["stat"]);
    const psMetadata =
      psInventory &&
      (readsMetadata(line, root, [
        "stat",
        "status",
        "cmdline",
        "wchan",
        "environ",
      ]) ||
        // procps reads the PID directory's UID without opening a directory FD.
        new RegExp(
          `^newfstatat\\([^,]+, "${root}", .*?, (?:0|AT_SYMLINK_NOFOLLOW)\\)`,
          "u",
        ).test(line));
    assert.ok(
      liveCollision &&
        !targetsHistoricalPid(line, historicalPid) &&
        (nodeStat || psMetadata),
      `Historical PID caused a non-inventory lookup in trace ${trace.pid}: ${line}`,
    );
  }
  return accesses;
}
