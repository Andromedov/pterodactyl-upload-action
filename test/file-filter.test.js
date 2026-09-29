const test = require("node:test");
const assert = require("node:assert/strict");
const { collectDeletionPlan } = require("../src/file-filter");

const target = "./plugins/CustomFishing/";
const file = (name) => ({ attributes: { name, is_directory: false } });
const directory = (name) => ({ attributes: { name, is_directory: true } });
const apiFile = (name) => ({ attributes: { name, is_file: true, is_symlink: false } });
const apiDirectory = (name) => ({ attributes: { name, is_file: false, is_symlink: false } });

function listing(tree, visited) {
  return async (path) => {
    visited.push(path);
    if (!(path in tree)) throw new Error(`Unexpected directory: ${path}`);
    return tree[path];
  };
}

test("whitelisted directory keeps its entire subtree", async () => {
  const visited = [];
  const tree = { [target]: [directory("data"), file("old.yml")] };
  const plan = await collectDeletionPlan(listing(tree, visited), target, "whitelist", ["data/"]);

  assert.deepEqual(visited, [target]);
  assert.deepEqual(plan, [{ root: target, files: ["old.yml"] }]);
});

test("whitelisted nested file keeps its parents and removes siblings", async () => {
  const visited = [];
  const tree = {
    [target]: [directory("data"), directory("cache"), file("old.yml")],
    "plugins/CustomFishing/data/": [file("settings.yml"), file("old.yml"), directory("nested")],
    "plugins/CustomFishing/data/nested/": [file("old.yml")],
  };
  const plan = await collectDeletionPlan(
    listing(tree, visited), target, "whitelist", ["data/settings.yml"]
  );

  assert.deepEqual(plan, [
    { root: "plugins/CustomFishing/data/", files: ["old.yml", "nested"] },
    { root: target, files: ["cache", "old.yml"] },
  ]);
  assert.equal(visited.includes("plugins/CustomFishing/cache/"), false);
});

test("blacklist finds matching files in nested directories", async () => {
  const visited = [];
  const tree = {
    [target]: [directory("data"), file("keep.yml")],
    "plugins/CustomFishing/data/": [file("cache.json"), file("settings.yml")],
  };
  const plan = await collectDeletionPlan(
    listing(tree, visited), target, "blacklist", ["data/cache.json"]
  );

  assert.deepEqual(plan, [
    { root: "plugins/CustomFishing/data/", files: ["cache.json"] },
  ]);
});

test("filename pattern matches at any depth", async () => {
  const visited = [];
  const tree = {
    [target]: [directory("data"), file("cache.json")],
    "plugins/CustomFishing/data/": [file("cache.json"), file("settings.yml")],
  };
  const plan = await collectDeletionPlan(
    listing(tree, visited), target, "blacklist", ["cache.json"]
  );

  assert.deepEqual(plan, [
    { root: "plugins/CustomFishing/data/", files: ["cache.json"] },
    { root: target, files: ["cache.json"] },
  ]);
});

test("directory name pattern can preserve a nested directory", async () => {
  const visited = [];
  const tree = {
    [target]: [directory("world")],
    "plugins/CustomFishing/world/": [directory("data"), file("old.yml")],
  };
  const plan = await collectDeletionPlan(
    listing(tree, visited), target, "whitelist", ["data/"]
  );

  assert.deepEqual(plan, [
    { root: "plugins/CustomFishing/world/", files: ["old.yml"] },
  ]);
  assert.equal(visited.includes("plugins/CustomFishing/world/data/"), false);
});

test("*/data/ preserves data directories at every depth", async () => {
  const visited = [];
  const tree = {
    [target]: [directory("data"), directory("world"), file("old.yml")],
    "plugins/CustomFishing/world/": [directory("data"), directory("region"), file("old.yml")],
    "plugins/CustomFishing/world/region/": [directory("data"), file("old.yml")],
  };
  const plan = await collectDeletionPlan(
    listing(tree, visited), target, "whitelist", ["*/data/"]
  );

  assert.deepEqual(plan, [
    { root: "plugins/CustomFishing/world/region/", files: ["old.yml"] },
    { root: "plugins/CustomFishing/world/", files: ["old.yml"] },
    { root: target, files: ["old.yml"] },
  ]);
  assert.equal(visited.some((directory) => directory.endsWith("/data/")), false);
});

test("Pterodactyl is_file responses preserve data directories", async () => {
  const visited = [];
  const tree = {
    [target]: [apiDirectory("data"), apiDirectory("world"), apiFile("old.yml")],
    "plugins/CustomFishing/world/": [apiDirectory("data"), apiFile("old.yml")],
  };
  const plan = await collectDeletionPlan(
    listing(tree, visited), target, "whitelist", ["*/data/"]
  );

  assert.deepEqual(plan, [
    { root: "plugins/CustomFishing/world/", files: ["old.yml"] },
    { root: target, files: ["old.yml"] },
  ]);
  assert.equal(visited.some((directory) => directory.endsWith("/data/")), false);
});

test("whitelist aborts before deletion when no item matches", async () => {
  const tree = {
    [target]: [apiDirectory("data"), apiFile("old.yml")],
    "plugins/CustomFishing/data/": [],
  };
  await assert.rejects(
    collectDeletionPlan(listing(tree, []), target, "whitelist", ["missing/"]),
    /Whitelist did not match/
  );
});

test("unknown file type aborts before deletion", async () => {
  const tree = { [target]: [{ attributes: { name: "data" } }] };
  await assert.rejects(
    collectDeletionPlan(listing(tree, []), target, "whitelist", ["data/"]),
    /Cannot determine file type/
  );
});

test("glob can match directories at any depth", async () => {
  const visited = [];
  const tree = {
    [target]: [directory("cache"), directory("data")],
    "plugins/CustomFishing/data/": [directory("cache"), file("settings.yml")],
  };
  const plan = await collectDeletionPlan(
    listing(tree, visited), target, "blacklist", ["**/cache/"]
  );

  assert.deepEqual(plan, [
    { root: "plugins/CustomFishing/data/", files: ["cache"] },
    { root: target, files: ["cache"] },
  ]);
  assert.equal(visited.includes("plugins/CustomFishing/cache/"), false);
});
