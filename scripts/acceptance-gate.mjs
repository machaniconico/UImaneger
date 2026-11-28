#!/usr/bin/env node
// 受け入れテストの CI ゲート。vitest の JSON レポートを読み、次のどれかなら失敗する。
// - skip / todo が 1 件でもある
// - 失敗したテストがある
// - この OS で必須の AC ID が、成功したテストの名前に 1 つでも見当たらない
// - 成功件数が scripts/acceptance-expected.json の total と違う
// 使い方: node scripts/acceptance-gate.mjs <report.json> [platform]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function checkAcceptanceReport(report, expected, platform) {
  const errors = [];
  const skipped = report.numPendingTests + report.numTodoTests;
  if (skipped) errors.push(`skipped acceptance tests: ${skipped}`);
  if (report.numFailedTests) errors.push(`failed acceptance tests: ${report.numFailedTests}`);

  const spec = expected.platforms[platform];
  if (!spec) {
    errors.push(`no expectation for platform: ${platform}`);
    return errors;
  }
  const passedNames = report.testResults.flatMap((file) =>
    file.assertionResults.filter((t) => t.status === "passed").map((t) => t.fullName)
  );
  const hasId = (id) => passedNames.some((name) => new RegExp(`(^|[^\\w-])${id}(?![\\w-])`).test(name));
  const missing = [...expected.common, ...spec.ids].filter((id) => !hasId(id));
  if (missing.length) errors.push(`acceptance criteria not run on ${platform}: ${missing.join(", ")}`);
  if (report.numPassedTests !== spec.total) {
    errors.push(`expected ${spec.total} passed acceptance tests on ${platform}, got ${report.numPassedTests}`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportPath, platform = process.platform] = process.argv.slice(2);
  if (!reportPath) {
    console.error("usage: node scripts/acceptance-gate.mjs <report.json> [platform]");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const expected = JSON.parse(readFileSync(new URL("./acceptance-expected.json", import.meta.url), "utf8"));
  const errors = checkAcceptanceReport(report, expected, platform);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(`acceptance: ${report.numPassedTests} passed, 0 skipped, all required criteria ran on ${platform}`);
}
