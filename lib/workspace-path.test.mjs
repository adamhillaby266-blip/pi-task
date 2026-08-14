import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  findMostSpecificWorkspace,
  normalizeWorkspacePath,
  workspaceContainsPath,
  workspaceDisplayName,
} = await jiti.import("./workspace-path.ts");

test("workspace paths use segment boundaries instead of prefix guesses", () => {
  assert.equal(workspaceContainsPath("/work/book", "/work/book"), true);
  assert.equal(workspaceContainsPath("/work/book", "/work/book/source"), true);
  assert.equal(workspaceContainsPath("/work/book", "/work/book-old"), false);
  assert.equal(workspaceContainsPath("/", "/work/book"), true);
});

test("workspace paths normalize Windows separators and casing", () => {
  assert.equal(normalizeWorkspacePath("C:\\Work\\Book\\"), "c:/work/book");
  assert.equal(workspaceContainsPath("C:\\Work\\Book", "c:/work/book/Source"), true);
  assert.equal(workspaceDisplayName("C:\\Work\\Book\\"), "book");
});

test("the most specific internal Project follows the active working directory", () => {
  const projects = [
    { id: "broad", rootPath: "/work" },
    { id: "specific", rootPath: "/work/book" },
    { id: "sibling", rootPath: "/work/audio" },
  ];
  assert.equal(findMostSpecificWorkspace(projects, "/work/book/source")?.id, "specific");
  assert.equal(findMostSpecificWorkspace(projects, "/other"), null);
  assert.equal(findMostSpecificWorkspace(projects, null), null);
});
