import { expect, it } from "vitest";
import { treePids } from "./runtime-matrix-processes.mjs";

it("ignores stale Windows parent links and reused PIDs during cleanup", () => {
  const tracked = new Map();
  const options = { platform: "win32", startedAt: 100 };
  expect(treePids([
    { pid: 12, parent: 11, createdAt: 40 },
    { pid: 13, parent: 11, createdAt: 102 },
    { pid: 11, parent: 1, createdAt: 101 },
  ], 11, tracked, options)).toEqual([13, 11]);
  expect(treePids([
    { pid: 13, parent: 88, createdAt: 200 },
    { pid: 14, parent: 13, createdAt: 202 },
  ], 11, tracked, options)).toEqual([]);
});

it("keeps a Windows descendant after the launcher exits", () => {
  const tracked = new Map();
  const options = { platform: "win32", startedAt: 100 };
  expect(treePids([
    { pid: 11, parent: 1, createdAt: 101 },
    { pid: 13, parent: 11, createdAt: 102 },
  ], 11, tracked, options)).toEqual([11, 13]);
  expect(treePids([{ pid: 13, parent: 1, createdAt: 102 }], 11, tracked, options)).toEqual([13]);
});
