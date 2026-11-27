// npm sbom の出力を検証してから compliance/sbom.cdx.json を置き換える。
// シェルのリダイレクトだと失敗時に既存 SBOM が空になるため、成功時のみ書き込む。
import { execFileSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const target = "compliance/sbom.cdx.json";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let out;
try {
  out = execFileSync(npm, ["sbom", "--sbom-format", "cyclonedx"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });
} catch (error) {
  console.error(`sbom: npm sbom failed (exit ${error.status ?? "?"}); ${target} is unchanged`);
  process.exit(1);
}
const doc = JSON.parse(out);
if (doc.bomFormat !== "CycloneDX" || !Array.isArray(doc.components) || doc.components.length === 0) {
  console.error(`sbom: unexpected output; ${target} is unchanged`);
  process.exit(1);
}
writeFileSync(`${target}.tmp`, out);
renameSync(`${target}.tmp`, target);
console.log(`sbom: wrote ${doc.components.length} components to ${target}`);
