import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkAcceptanceReport } from "./acceptance-gate.mjs";

const expected = JSON.parse(
  readFileSync(new URL("./acceptance-expected.json", import.meta.url), "utf8")
);

function reportFor(names, { pending = 0, todo = 0, failed = 0 } = {}) {
  return {
    numPassedTests: names.length,
    numPendingTests: pending,
    numTodoTests: todo,
    numFailedTests: failed,
    testResults: [
      {
        assertionResults: [
          ...names.map((fullName) => ({ fullName, status: "passed" })),
          ...Array.from({ length: failed }, (_, i) => ({ fullName: `failing ${i}`, status: "failed" })),
        ],
      },
    ],
  };
}

/** 必須 AC を 1 件ずつ含み、残りを AC なしのテストで total まで埋めたレポート */
function fullReport(platform) {
  const spec = expected.platforms[platform];
  const ids = [...expected.common, ...spec.ids];
  const names = ids.map((id) => `suite > ${id} some_behavior`);
  while (names.length < spec.total) names.push(`suite > legacy test ${names.length}`);
  return reportFor(names);
}

describe("acceptance gate", () => {
  it.each(["linux", "darwin", "win32"])("passes a complete report on %s", (platform) => {
    expect(checkAcceptanceReport(fullReport(platform), expected, platform)).toEqual([]);
  });

  it("fails when a platform-specific criterion silently disappears", () => {
    const report = fullReport("win32");
    const file = report.testResults[0];
    file.assertionResults = file.assertionResults.map((t) =>
      t.fullName.includes("AC-4-5") ? { ...t, fullName: "suite > replaced test" } : t
    );
    expect(checkAcceptanceReport(report, expected, "win32")).toEqual([
      "acceptance criteria not run on win32: AC-4-5",
    ]);
  });

  it("fails when the passed count drifts from the expectation", () => {
    const report = fullReport("linux");
    report.testResults[0].assertionResults.pop();
    report.numPassedTests -= 1;
    expect(checkAcceptanceReport(report, expected, "linux")).toEqual([
      `expected ${expected.platforms.linux.total} passed acceptance tests on linux, got ${expected.platforms.linux.total - 1}`,
    ]);
  });

  it("fails on skipped, todo, or failed tests", () => {
    const report = fullReport("darwin");
    report.numPendingTests = 1;
    report.numTodoTests = 1;
    report.numFailedTests = 2;
    expect(checkAcceptanceReport(report, expected, "darwin")).toEqual([
      "skipped acceptance tests: 2",
      "failed acceptance tests: 2",
    ]);
  });

  it("does not treat AC-2-1 as present when only AC-2-10 ran", () => {
    const report = fullReport("linux");
    const file = report.testResults[0];
    file.assertionResults = file.assertionResults.map((t) =>
      /AC-2-1 /.test(t.fullName) ? { ...t, fullName: "suite > other" } : t
    );
    expect(checkAcceptanceReport(report, expected, "linux")).toEqual([
      "acceptance criteria not run on linux: AC-2-1",
    ]);
  });

  it("fails on an unknown platform", () => {
    expect(checkAcceptanceReport(fullReport("linux"), expected, "aix")).toEqual([
      "no expectation for platform: aix",
    ]);
  });
});
