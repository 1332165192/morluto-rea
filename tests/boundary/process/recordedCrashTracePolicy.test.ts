import { expect, it } from "vitest";
import {
  assertHistoricalPidReads,
  nodeInventoryThreads,
} from "../../../scripts/verify/recorded-crash/trace-policy.mjs";

const node = "/fixture/node";
const stat = 'openat(AT_FDCWD, "/proc/900/stat", O_RDONLY|O_CLOEXEC) = 22';
const traces = [
  {
    pid: 100,
    text: [
      'execve("/fixture/node", ["node", "rea.mjs"], 0x1 /* 3 vars */) = 0',
      "clone3({flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND}, 88) = 101",
      "clone(child_stack=NULL, flags=SIGCHLD) = 102",
    ].join("\n"),
  },
  { pid: 101, text: stat },
  { pid: 102, text: stat },
];

const check = (pid: number, text: string, liveCollision = true) =>
  assertHistoricalPidReads({
    trace: { pid, text },
    historicalPid: 900,
    nodeThreads: nodeInventoryThreads(traces, node),
    liveCollision,
    psInventory: false,
  });

it("allows a live collision's stat read only in an observed Node process or thread", () => {
  expect([...nodeInventoryThreads(traces, node)]).toEqual([100, 101]);
  expect(check(100, stat)).toEqual([stat]);
  expect(check(101, stat)).toEqual([stat]);
  expect(() => check(102, stat)).toThrow("non-inventory lookup");
});

it.each(["mem", "maps", "environ", "exe", "root"])(
  "rejects Node access to the live historical PID's %s",
  (name) => {
    expect(() => check(101, stat.replace("/stat", `/${name}`))).toThrow(
      "non-inventory lookup",
    );
  },
);

it("rejects an unlisted historical PID lookup even from an observed inventory thread", () => {
  expect(() => check(101, stat, false)).toThrow("non-inventory lookup");
});

it("keeps exec-replaced threads foreign and follows acknowledged unfinished thread clones", () => {
  const observed = [
    {
      pid: 100,
      text: [
        traces[0]!.text,
        "clone3({flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND}, 88 <unfinished ...>",
        "<... clone3 resumed>) = 103",
      ].join("\n"),
    },
    { pid: 101, text: 'execve("/fixture/gdb", ["gdb"], 0x1) = 0\n' + stat },
    { pid: 103, text: stat },
  ];
  expect([...nodeInventoryThreads(observed, node)]).toEqual([100, 103]);
});
