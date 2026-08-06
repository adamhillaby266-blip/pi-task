import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const componentsDirectory = fileURLToPath(new URL("..", import.meta.url));

function moduleCssFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return moduleCssFiles(path);
    return entry.name.endsWith(".module.css") ? [path] : [];
  });
}

function unscopedSelectors(css) {
  const failures = [];
  for (const match of css.matchAll(/(^|})([^{}]+)\{/g)) {
    const selector = match[2].trim();
    if (!selector || selector.startsWith("@")) continue;
    for (const part of selector.split(",").map((value) => value.trim())) {
      if (!/\.[A-Za-z_-][\w-]*/.test(part) && !/#[-\w]+/.test(part) && !/:global\(/.test(part)) {
        failures.push(part);
      }
    }
  }
  return failures;
}

test("component CSS Module selectors retain local scope for webpack production builds", () => {
  const failures = moduleCssFiles(componentsDirectory)
    .flatMap((path) => unscopedSelectors(readFileSync(path, "utf8")).map((selector) => `${path}: ${selector}`));
  assert.deepEqual(failures, []);
});
