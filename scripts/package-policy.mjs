import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const rootLock = lock.packages?.[""] ?? {};
const failures = [];

function fail(message) {
  failures.push(message);
}

function assertObjectEqual(name, actual, expected) {
  const actualText = JSON.stringify(actual ?? {}, Object.keys(actual ?? {}).sort());
  const expectedText = JSON.stringify(expected ?? {}, Object.keys(expected ?? {}).sort());
  if (actualText !== expectedText) {
    fail(`${name} in package-lock.json is not synchronized with package.json`);
  }
}

function assertExactVersions(groupName) {
  const deps = pkg[groupName] ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) {
      fail(`${groupName}.${name} must use an exact version, got "${spec}"`);
      continue;
    }
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    if (locked !== spec) {
      fail(`${groupName}.${name} is ${spec} but lockfile has ${locked ?? "(missing)"}`);
    }
  }
}

if (!/^npm@\d+\.\d+\.\d+$/.test(pkg.packageManager ?? "")) {
  fail(`packageManager must pin an exact npm version, got "${pkg.packageManager ?? ""}"`);
}

if (!pkg.engines?.node || !pkg.engines?.npm) {
  fail("engines.node and engines.npm must be declared");
}

assertExactVersions("dependencies");
assertExactVersions("devDependencies");
assertObjectEqual("dependencies", rootLock.dependencies, pkg.dependencies);
assertObjectEqual("devDependencies", rootLock.devDependencies, pkg.devDependencies);
assertObjectEqual("engines", rootLock.engines, pkg.engines);

for (const forbidden of ["http-proxy", "@types/http-proxy"]) {
  if (pkg.dependencies?.[forbidden] || pkg.devDependencies?.[forbidden]) {
    fail(`${forbidden} is forbidden; use the built-in proxy implementation`);
  }
}

if (failures.length > 0) {
  console.error("\npackage policy failed:");
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log("package policy: ok");
