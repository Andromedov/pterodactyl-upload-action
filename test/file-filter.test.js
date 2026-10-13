const test = require("node:test");
const assert = require("node:assert/strict");
const { collectDeletionPlan, parseFilesList } = require("../src/file-filter");
const { normalizeServerPath } = require("../src/server-path");

const target = "/plugins/CustomFishing";
const file = (name) => ({ attributes: { name, is_directory: false } });
const directory = (name) => ({ attributes: { name, is_directory: true } });
const apiFile = (name) => ({ attributes: { name, is_file: true, is_symlink: false } });
const apiDirectory = (name) => ({ attributes: { name, is_file: false, is_symlink: false } });

function listing(tree, visited) {
  tree = Object.fromEntries(Object.entries(tree).map(([root, entries]) => [normalizeServerPath(root), entries]));
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
    { root: "/plugins/CustomFishing/data", files: ["old.yml", "nested"] },
    { root: target, files: ["cache", "old.yml"] },
  ]);
  assert.equal(visited.includes("/plugins/CustomFishing/cache"), false);
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
    { root: "/plugins/CustomFishing/data", files: ["cache.json"] },
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
    { root: "/plugins/CustomFishing/data", files: ["cache.json"] },
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
    { root: "/plugins/CustomFishing/world", files: ["old.yml"] },
  ]);
  assert.equal(visited.includes("/plugins/CustomFishing/world/data"), false);
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
    { root: "/plugins/CustomFishing/world/region", files: ["old.yml"] },
    { root: "/plugins/CustomFishing/world", files: ["old.yml"] },
    { root: target, files: ["old.yml"] },
  ]);
  assert.equal(visited.some((directory) => directory.endsWith("/data")), false);
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
    { root: "/plugins/CustomFishing/world", files: ["old.yml"] },
    { root: target, files: ["old.yml"] },
  ]);
  assert.equal(visited.some((directory) => directory.endsWith("/data")), false);
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
    { root: "/plugins/CustomFishing/data", files: ["cache"] },
    { root: target, files: ["cache"] },
  ]);
  assert.equal(visited.includes("/plugins/CustomFishing/cache"), false);
});

test("brace patterns with slash alternatives preserve nested files and their parents", async () => {
  const tree = {
    [target]: [apiDirectory("a"), apiDirectory("c"), apiFile("old")],
    [`${target}/a`]: [apiDirectory("b"), apiFile("old")],
    [`${target}/c`]: [apiDirectory("d")],
    [`${target}/a/b`]: [apiFile("keep.yml"), apiFile("old")],
    [`${target}/c/d`]: [apiFile("keep.yml")],
  };
  const plan = await collectDeletionPlan(listing(tree, []), target, "whitelist", ["{a/b,c/d}/keep.yml"]);
  assert.deepEqual(plan, [
    { root: `${target}/a/b`, files: ["old"] },
    { root: `${target}/a`, files: ["old"] },
    { root: target, files: ["old"] },
  ]);
});

test("absolute server patterns preserve paths with every target spelling", async () => {
  for (const spelling of [target, `.${target}/`, target.slice(1)]) {
    const tree = {
      [target]: [apiDirectory("data"), apiDirectory("cache")],
    };
    const plan = await collectDeletionPlan(listing(tree, []), spelling, "whitelist", [`${target}/data/`]);
    assert.deepEqual(plan, [{ root: target, files: ["cache"] }]);
  }
});

test("globstar and wildcard file protections preserve deep ancestors and dotfiles", async () => {
  const tree = {
    [target]: [apiDirectory(".hidden"), apiFile(".gitattributes"), apiFile("old.yml")],
    [`${target}/.hidden`]: [apiDirectory("deep"), apiFile("old.yml")],
    [`${target}/.hidden/deep`]: [apiFile("keep-one.json"), apiFile("old.yml")],
  };
  const plan = await collectDeletionPlan(listing(tree, []), target, "whitelist", ["**/keep-*.json", ".gitattributes"]);
  assert.deepEqual(plan, [
    { root: `${target}/.hidden/deep`, files: ["old.yml"] },
    { root: `${target}/.hidden`, files: ["old.yml"] },
    { root: target, files: ["old.yml"] },
  ]);
});

test("literal names starting with # or ! are not comments or inverted patterns", async () => {
  const tree = { [target]: [apiFile("#keep"), apiFile("!keep"), apiFile("old")] };
  const plan = await collectDeletionPlan(listing(tree, []), target, "whitelist", ["#keep", "!keep"]);
  assert.deepEqual(plan, [{ root: target, files: ["old"] }]);
});

test("a matching empty directory counts as whitelist protection", async () => {
  const tree = { [target]: [apiDirectory("data"), apiFile("old")] };
  const visited = [];
  const plan = await collectDeletionPlan(listing(tree, visited), target, "whitelist", ["data/", "missing/"]);
  assert.deepEqual(plan, [{ root: target, files: ["old"] }]);
  assert.deepEqual(visited, [target]);
});

const link = (name) => ({ attributes: { name, is_file: false, is_symlink: true } });

test("root directory whitelist keeps only target children and skips unprotected trees", async () => {
  const visited = [];
  const tree = {
    [target]: [apiDirectory("config"), apiDirectory("data"), apiDirectory("logs"), apiDirectory("assets"), apiFile("old")],
    [`${target}/assets`]: [apiDirectory("data"), apiDirectory("config"), apiDirectory("logs")],
  };
  const plan = await collectDeletionPlan(listing(tree, visited), target, "whitelist", ["./config/", "./data/", "./logs/"]);
  assert.deepEqual(plan, [{ root: target, files: ["assets", "old"] }]);
  assert.deepEqual(visited, [target]);
});

test("root directory whitelist does not match regular files with the same name", async () => {
  const visited = [];
  const tree = { [target]: [apiDirectory("data"), apiFile("config"), apiFile("logs")] };
  const plan = await collectDeletionPlan(listing(tree, visited), target, "whitelist", ["./config/", "./data/", "./logs/"]);
  assert.deepEqual(plan, [{ root: target, files: ["config", "logs"] }]);
  assert.deepEqual(visited, [target]);
});

test("root anchoring coexists with legacy directory and nested glob protections", async () => {
  const visited = [];
  const tree = {
    [target]: [apiDirectory("config"), apiDirectory("packs"), apiDirectory("assets"), apiFile("old")],
    [`${target}/packs`]: [apiDirectory("world"), apiDirectory("config")],
    [`${target}/packs/world`]: [apiFile("keep.yml"), apiFile("old"), apiDirectory("data")],
    [`${target}/packs/config`]: [apiFile("old")],
    [`${target}/assets`]: [apiDirectory("logs"), apiFile("old")],
    [`${target}/assets/logs`]: [],
    [`${target}/packs/world/data`]: [apiFile("old")],
  };
  const plan = await collectDeletionPlan(listing(tree, visited), target, "whitelist",
    ["./config/", "data/", "./packs/**/keep.{yml,json}"]);
  assert.deepEqual(plan, [
    { root: `${target}/packs/world`, files: ["old"] },
    { root: `${target}/packs`, files: ["config"] },
    { root: target, files: ["assets", "old"] },
  ]);
  assert.deepEqual(visited, [target, `${target}/packs`, `${target}/packs/world`, `${target}/packs/config`, `${target}/assets`, `${target}/assets/logs`]);
});

test("anchored brace paths keep nested matches and prune unrelated branches", async () => {
  const visited = [];
  const tree = {
    [target]: [apiDirectory("a"), apiDirectory("c"), apiDirectory("assets")],
    [`${target}/a`]: [apiDirectory("b"), apiDirectory("other")],
    [`${target}/c`]: [apiDirectory("d")],
    [`${target}/a/b`]: [apiFile("keep.yml"), apiFile("old")],
    [`${target}/c/d`]: [apiFile("keep.json")],
  };
  const plan = await collectDeletionPlan(listing(tree, visited), target, "whitelist", ["./{a/b,c/d}/keep.{yml,json}"]);
  assert.deepEqual(plan, [
    { root: `${target}/a/b`, files: ["old"] },
    { root: `${target}/a`, files: ["other"] },
    { root: target, files: ["assets"] },
  ]);
  assert.equal(visited.length, 5);
});

test("anchored single-star directory glob retains its target-relative depth", async () => {
  const visited = [];
  const tree = {
    [target]: [apiDirectory("data"), apiDirectory("packs")],
    [`${target}/data`]: [],
    [`${target}/packs`]: [apiDirectory("data"), apiDirectory("world")],
  };
  const plan = await collectDeletionPlan(listing(tree, visited), target, "whitelist", ["./*/data/"]);
  assert.deepEqual(plan, [
    { root: `${target}/packs`, files: ["world"] },
    { root: target, files: ["data"] },
  ]);
  assert.deepEqual(visited, [target, `${target}/data`, `${target}/packs`]);
});

test("anchored patterns never fall back to absolute server paths", async () => {
  const visited = [];
  const tree = { [target]: [apiDirectory("data"), apiDirectory("config")] };
  const plan = await collectDeletionPlan(listing(tree, visited), target, "whitelist", ["./data/", `.${target}/config/`]);
  assert.deepEqual(plan, [{ root: target, files: ["config"] }]);
  assert.deepEqual(visited, [target]);
});

test("anchored blacklist deletes root directories and nested glob files without matching nested names", async () => {
  const visited = [];
  const tree = {
    [target]: [apiDirectory("data"), apiDirectory("packs"), link("logs")],
    [`${target}/packs`]: [apiDirectory("data"), apiDirectory("world")],
    [`${target}/packs/data`]: [apiFile("keep.yml")],
    [`${target}/packs/world`]: [apiFile("old.yml"), apiFile("keep.json")],
  };
  const plan = await collectDeletionPlan(listing(tree, visited), target, "blacklist", ["./data/", "./logs/", "./packs/**/old.*"]);
  assert.deepEqual(plan, [
    { root: `${target}/packs/world`, files: ["old.yml"] },
    { root: target, files: ["data"] },
  ]);
  assert.deepEqual(visited, [target, `${target}/packs`, `${target}/packs/data`, `${target}/packs/world`]);
});

test("root directory whitelist preserves matching symlinks and removes unrelated links without traversal", async () => {
  const visited = [];
  const tree = { [target]: [link("data"), link("assets"), apiFile("old")] };
  const plan = await collectDeletionPlan(listing(tree, visited), target, "whitelist", ["./data/", "./logs/"]);
  assert.deepEqual(plan, [{ root: target, files: ["assets", "old"] }]);
  assert.deepEqual(visited, [target]);
});

test("anchored nested protection under a symlink fails without following it", async () => {
  const visited = [];
  const tree = { [target]: [apiDirectory("data"), link("packs")] };
  await assert.rejects(collectDeletionPlan(listing(tree, visited), target, "whitelist", ["./data/", "./packs/**/keep.yml"]),
    /Cannot verify whitelist descendants through symbolic link/);
  assert.deepEqual(visited, [target]);
});

test("empty whitelist fails before listing", async () => {
  const visited = [];
  await assert.rejects(collectDeletionPlan(listing({}, visited), target, "whitelist", []), /Whitelist is empty/);
  assert.deepEqual(visited, []);
});

test("missing root protections fail closed with one listing even when matching nested names exist", async () => {
  const visited = [];
  const tree = { [target]: [apiDirectory("assets")], [`${target}/assets`]: [apiDirectory("data")] };
  await assert.rejects(collectDeletionPlan(listing(tree, visited), target, "whitelist", ["./data/"]), /Whitelist did not match/);
  assert.deepEqual(visited, [target]);
});

test("directory whitelist preserves a matching symlink without following it", async () => {
  const tree = { [target]: [link("data"), link("cache"), apiFile("old")] };
  const visited = [];
  const plan = await collectDeletionPlan(listing(tree, visited), target, "whitelist", ["data/"]);
  assert.deepEqual(plan, [{ root: target, files: ["cache", "old"] }]);
  assert.deepEqual(visited, [target]);
});

test("blacklist never traverses symlinks or treats them as recursive directories", async () => {
  const tree = { [target]: [link("data"), link("cache"), apiFile("old")] };
  const visited = [];
  const plan = await collectDeletionPlan(listing(tree, visited), target, "blacklist", ["data/", "cache"]);
  assert.deepEqual(plan, [{ root: target, files: ["cache"] }]);
  assert.deepEqual(visited, [target]);
});

test("nested protection under a symlink stops the entire plan", async () => {
  const tree = { [target]: [apiDirectory("data"), link("world"), apiFile("old")] };
  await assert.rejects(
    collectDeletionPlan(listing(tree, []), target, "whitelist", ["data/", "world/keep.yml"]),
    /Cannot verify whitelist descendants through symbolic link.*world/,
  );
});

test("blacklist with no patterns makes no requests and deletes nothing", async () => {
  const visited = [];
  assert.deepEqual(await collectDeletionPlan(listing({}, visited), target, "blacklist", []), []);
  assert.deepEqual(visited, []);
});

test("unsafe patterns are rejected before listing", async () => {
  for (const pattern of ["../data/", "foo/../data/", "", "\0"]) {
    const visited = [];
    await assert.rejects(collectDeletionPlan(listing({}, visited), target, "whitelist", [pattern]), /File patterns/);
    assert.deepEqual(visited, []);
  }
});

test("files-list parser separates entries while preserving glob grouping commas", () => {
  assert.deepEqual(parseFilesList(" config/, data/, logs/, "), ["config/", "data/", "logs/"]);
  assert.deepEqual(parseFilesList("{a/b,c/d}/keep.yml, **/@(keep|other).json, file[ab,].txt"),
    ["{a/b,c/d}/keep.yml", "**/@(keep|other).json", "file[ab,].txt"]);
  assert.deepEqual(parseFilesList(""), []);
});
