export function treePids(snapshot, rootPid, tracked, { platform = process.platform, startedAt } = {}) {
  const windows = platform === "win32";
  // Windows では作成時刻で PID 再利用を見分けるため、startedAt が無いと停止確認が素通りしてしまう。
  if (windows && !Number.isFinite(startedAt)) throw new TypeError("treePids: startedAt is required on win32");
  const live = new Map(snapshot.map((process) => [process.pid, process]));
  if (!tracked.has(rootPid)) {
    const createdAt = live.get(rootPid)?.createdAt;
    tracked.set(rootPid, windows ? Math.max(startedAt, createdAt ?? startedAt) : 0);
  }

  // Keep observed descendants even if they are reparented during shutdown.
  let before;
  do {
    before = tracked.size;
    for (const { pid, parent, group, createdAt } of snapshot) {
      if (tracked.has(pid)) continue;
      if (windows) {
        const parentCreatedAt = tracked.get(parent);
        const liveParent = live.get(parent);
        // Win32 ParentProcessId can refer to an earlier process with the same PID.
        if (parentCreatedAt === undefined || createdAt < parentCreatedAt ||
            (liveParent && liveParent.createdAt !== parentCreatedAt)) continue;
        tracked.set(pid, createdAt);
      } else if (group === rootPid || tracked.has(parent)) {
        tracked.set(pid, 0);
      }
    }
  } while (tracked.size !== before);
  return snapshot
    .filter(({ pid, createdAt }) => tracked.has(pid) && (!windows || tracked.get(pid) === createdAt))
    .map(({ pid }) => pid);
}
