import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildChildEnv } from "../server/lib/child-env.ts";
import { prepareCommandInvocation } from "../server/lib/package-manager.ts";
import {
  findFreePort, killAllChildrenSync, killGroup, sleep, startTarget, TargetStartupError,
} from "../server/lib/runner.ts";
import { fixtures } from "./runtime-matrix-fixtures.mjs";

const windows = process.platform === "win32";
const knownRuntimes = new Set(fixtures.map(({ runtime }) => runtime));
const { values: options } = parseArgs({
  options: { json: { type: "boolean" }, only: { type: "string" } },
});

function runtimeList(input) {
  const names = [...new Set(input.split(",").map((name) => name.trim()).filter(Boolean))];
  for (const name of names) {
    if (!knownRuntimes.has(name)) throw new Error(`Unknown runtime: ${name}`);
  }
  return names;
}

const required = runtimeList(process.env.RUNTIME_MATRIX_REQUIRE ?? "");
const selected = new Set(options.only === undefined ? knownRuntimes : runtimeList(options.only));
if (!selected.size) throw new Error("--only must select at least one runtime");
for (const name of required) {
  if (!selected.has(name)) throw new Error(`Required runtime excluded by --only: ${name}`);
}

const toolArgs = {
  java: ["-version"], go: ["version"], php: ["-v"], dotnet: ["--list-sdks"],
};

function syncCommand(command, args) {
  const invocation = prepareCommandInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, {
    encoding: "utf8", timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
}

const versionCache = new Map();
function toolVersion(tool) {
  if (versionCache.has(tool)) return versionCache.get(tool);
  let candidates = [tool];
  if (tool === "python" && !windows) candidates = ["python3", "python"];
  if (["java", "javac"].includes(tool) && process.env.JAVA_HOME) {
    candidates = [join(process.env.JAVA_HOME, "bin", windows ? `${tool}.exe` : tool)];
  }
  let info;
  for (const command of candidates) {
    const result = syncCommand(command, toolArgs[tool] ?? ["--version"]);
    if (result.error?.code === "ENOENT" || (windows && result.status === 9009)) continue;
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (result.error || result.status !== 0) {
      throw new Error(`${command} version probe failed: ${result.error ?? output}`);
    }
    if (tool === "dotnet" && !/^10\./m.test(output)) {
      info = { missing: ".NET 10 SDK not found" };
      break;
    }
    const line = output.split(/\r?\n/).find((value) => /\d/.test(value));
    info = { command, version: tool === "dotnet" ? output.match(/^10\.\S+/m)[0] : line ?? output };
    break;
  }
  info ??= { missing: `${candidates.join("/")} not found on PATH` };
  versionCache.set(tool, info);
  return info;
}

let setupChild;
function runSetup(root, env, command, args, { capture = false } = {}) {
  const invocation = prepareCommandInvocation(command, args);
  return new Promise((resolve, reject) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: root, env: buildChildEnv({}, env), detached: true, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    setupChild = proc;
    let output = "";
    const stdout = [];
    let timedOut = false;
    const append = (chunk) => { output = (output + chunk).slice(-8000); };
    proc.stdout.on("data", append);
    if (capture) proc.stdout.on("data", (chunk) => stdout.push(chunk));
    proc.stderr.on("data", append);
    const timer = setTimeout(async () => {
      timedOut = true;
      await killGroup(proc);
    }, 300_000);
    proc.once("error", reject);
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      setupChild = undefined;
      if (!timedOut && code === 0) resolve(capture ? Buffer.concat(stdout).toString("utf8") : undefined);
      else reject(new Error(`${command} ${args.join(" ")} ${timedOut ? "timed out" : `exited with ${code ?? signal}`}\n${output.trim()}`));
    });
  });
}

function processSnapshot() {
  const command = windows ? "powershell.exe" : "ps";
  const args = windows
    ? ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"]
    : ["-ax", "-o", "pid=,ppid=,pgid=,stat="];
  const result = syncCommand(command, args);
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Cannot inspect process tree: ${result.error ?? result.stderr}`);
  }
  return result.stdout.trim().split(/\r?\n/).map((line) => {
    const [pid, parent, group, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), state };
  }).filter(({ state }) => !state?.startsWith("Z")); // Zombies have already exited.
}

function treePids(snapshot, rootPid, tracked = new Set([rootPid])) {
  // Keep observed descendants even if they are reparented during shutdown.
  let before;
  do {
    before = tracked.size;
    for (const { pid, parent, group } of snapshot) {
      if (group === rootPid || tracked.has(parent)) tracked.add(pid);
    }
  } while (tracked.size !== before);
  return snapshot.filter(({ pid }) => tracked.has(pid)).map(({ pid }) => pid);
}

async function stopAndVerify(target, port) {
  const tracked = new Set([target.proc.pid]);
  try {
    treePids(processSnapshot(), target.proc.pid, tracked);
  } finally {
    await killGroup(target.proc);
  }
  const ports = [...new Set([port, target.port])].filter((p) => p > 0);
  const deadline = Date.now() + 8_000;
  let remaining;
  let busy;
  do {
    remaining = treePids(processSnapshot(), target.proc.pid, tracked);
    if (windows) {
      // taskkill /T needs a live root. After an early exit, stop surviving descendants by PID.
      for (const pid of remaining) {
        const result = syncCommand("taskkill", ["/pid", String(pid), "/t", "/f"]);
        if (result.error) throw result.error;
      }
    }
    busy = (await Promise.all(ports.map(async (p) => ({
      p, free: await findFreePort(p) === p,
    })))).filter(({ free }) => !free).map(({ p }) => p);
    if (!remaining.length && !busy.length) return;
    await sleep(150);
  } while (Date.now() < deadline);
  throw new Error(`Cleanup failed; live PIDs: ${remaining.join(", ") || "none"}; busy ports: ${busy.join(", ") || "none"}`);
}

async function verifyHttp(target, marker, path, javascript = false) {
  const host = target.host === "::1" ? "[::1]" : "127.0.0.1";
  const url = `http://${host}:${target.port}${path}`;
  const deadline = Date.now() + 30_000;
  let last;
  do {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000) });
      const body = await response.text();
      const type = response.headers.get("content-type") ?? "";
      const hasMarker = body.includes(marker);
      // webpack dev server はビルド失敗したモジュールを `throw new Error("Module build failed ...")` 入りの
      // 200 JS として配信し、エラー文に周辺ソース(marker を含む)を引用する。これを PASS にしない。
      // eval 系 devtool ではモジュール本文が文字列化されるため、エスケープされた引用符も許す。
      const buildFailed = javascript && /throw new (?:Syntax)?Error\(\\?["'`]Module (?:build|parse) failed/.test(body);
      if (response.status === 200 && hasMarker && !buildFailed && (!javascript || /(?:java|ecma)script/i.test(type))) return;
      last = `HTTP ${response.status} (${type || "no content type"}), marker ${hasMarker ? "present" : "absent"}${buildFailed ? ", module build failed" : ""}: ${body.slice(0, 400)}`;
    } catch (error) {
      last = `${error.message} (${error.cause?.code ?? "request failed"})`;
    }
    await sleep(250);
  } while (Date.now() < deadline && target.proc.exitCode === null && target.proc.signalCode === null);
  throw new Error(`${url}: ${last}`);
}

async function verifyFixture(fixture, portStart, result) {
  const versions = Object.fromEntries(fixture.tools.map((tool) => [tool, toolVersion(tool)]));
  result.runtimeVersion = Object.entries(versions)
    .filter(([, info]) => info.version)
    .map(([tool, info]) => `${tool} ${info.version}`).join(" / ");
  const missing = Object.values(versions).filter((info) => info.missing);
  if (missing.length) {
    result.status = "SKIP";
    result.reason = missing.map((info) => info.missing).join("; ");
    return;
  }

  const temp = await mkdtemp(join(tmpdir(), "uim-runtime-"));
  const root = join(temp, "app");
  const baseEnv = { ...process.env };
  const env = { ...baseEnv, NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", NUXT_TELEMETRY_DISABLED: "1" };
  const marker = `runtime-matrix-${randomUUID()}`;
  let target;
  let port;
  try {
    await mkdir(root);
    result.dependencies = await fixture.prepare({
      root, marker, versions, env, run: (command, args, options) => runSetup(root, env, command, args, options),
    });
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    Object.assign(process.env, env);
    port = await findFreePort(portStart);
    target = await startTarget(root, port);
    result.plan = { framework: target.plan.framework, command: target.plan.command, args: target.plan.args };
    result.requestedPort = port;
    result.port = target.port;
    if (target.plan.framework !== fixture.framework) {
      throw new Error(`Expected ${fixture.framework}; detected ${target.plan.framework}`);
    }
    result.checkPath = fixture.checkPath;
    await verifyHttp(target, marker, "/");
    if (fixture.checkPath) await verifyHttp(target, marker, fixture.checkPath, true);
  } catch (error) {
    if (error instanceof TargetStartupError) target = error.target;
    result.reason = [error.message, ...(error instanceof TargetStartupError ? [] : target?.logs.slice(-20) ?? [])].join("\n");
  } finally {
    if (target) {
      try {
        await stopAndVerify(target, port);
      } catch (error) {
        result.reason = [result.reason, error.message].filter(Boolean).join("\n");
      }
    }
    for (const key of Object.keys(env)) {
      if (baseEnv[key] === undefined) delete process.env[key];
      else if (baseEnv[key] !== env[key]) process.env[key] = baseEnv[key];
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
  result.status = result.reason ? "FAIL" : "PASS";
}

let interrupted;
process.once("exit", killAllChildrenSync);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = signal;
    killAllChildrenSync();
    if (setupChild) void killGroup(setupChild);
  });
}

const results = [];
const portBase = 28_000 + process.pid % 12_000;
for (const [index, fixture] of fixtures.entries()) {
  if (interrupted) break;
  if (!selected.has(fixture.runtime)) continue;
  const started = performance.now();
  const result = { name: fixture.name, runtime: fixture.runtime };
  console.error(`[runtime-matrix] ${fixture.name}`);
  try {
    await verifyFixture(fixture, portBase + 10 * index, result);
  } catch (error) {
    result.status = "FAIL";
    result.reason = [result.reason, error.message].filter(Boolean).join("\n");
  }
  result.durationMs = Math.round(performance.now() - started);
  if (result.status === "SKIP") result.required = required.includes(fixture.runtime);
  results.push(result);
  console.error(`[runtime-matrix] ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
}

if (options.json) {
  console.log(JSON.stringify({ platform: process.platform, release: release(), arch: process.arch, results }, null, 2));
} else {
  console.table(results.map((result) => ({
    configuration: result.name,
    result: result.status === "SKIP" ? `SKIP (${result.reason})${result.required ? " [required]" : ""}` : result.status,
    seconds: (result.durationMs / 1000).toFixed(2),
    runtimeVersion: result.runtimeVersion || "—",
  })));
}
if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
else if (results.some((result) => result.status === "FAIL" || result.required)) process.exitCode = 1;
