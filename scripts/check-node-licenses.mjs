import { spawnSync } from "node:child_process";

import parseExpression from "spdx-expression-parse";

const deniedFamilies = /^(?:AGPL|GPL)-/;

function permitsWithoutDeniedLicense(expression) {
  const node = typeof expression === "string" ? parseExpression(expression) : expression;

  if (node.license) return !deniedFamilies.test(node.license);

  if (node.conjunction === "or") {
    return permitsWithoutDeniedLicense(node.left) || permitsWithoutDeniedLicense(node.right);
  }

  if (node.conjunction === "and") {
    return permitsWithoutDeniedLicense(node.left) && permitsWithoutDeniedLicense(node.right);
  }

  throw new Error(`Unsupported SPDX expression node: ${JSON.stringify(node)}`);
}

function dependencyLabel(dependency) {
  const versions = Array.isArray(dependency.versions) ? dependency.versions.join(", ") : "unknown";
  return `${dependency.name}@${versions}`;
}

function loadLicenseReport() {
  const result = spawnSync("pnpm", ["licenses", "list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  return JSON.parse(result.stdout);
}

function main() {
  const denied = [];
  const invalid = [];

  for (const [expression, dependencies] of Object.entries(loadLicenseReport())) {
    try {
      if (!permitsWithoutDeniedLicense(expression)) {
        denied.push({
          expression,
          dependencies: dependencies.map(dependencyLabel).sort(),
        });
      }
    } catch (error) {
      invalid.push({ expression, error });
    }
  }

  if (denied.length === 0 && invalid.length === 0) {
    console.log("Node dependency licenses ok");
    return;
  }

  for (const { expression, dependencies } of denied.sort((a, b) =>
    a.expression.localeCompare(b.expression),
  )) {
    console.error(`denied license ${expression}:`);
    for (const dependency of dependencies) console.error(`  ${dependency}`);
  }

  for (const { expression, error } of invalid.sort((a, b) =>
    a.expression.localeCompare(b.expression),
  )) {
    console.error(`invalid license expression ${expression}: ${error.message}`);
  }

  process.exitCode = 1;
}

main();
