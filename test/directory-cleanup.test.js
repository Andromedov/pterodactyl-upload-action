const test = require("node:test");
const assert = require("node:assert/strict");
const { deleteAllFilesInDirectory } = require("../src/directory-cleanup");

const target = "/plugins/MythicMobs";
const file = (name) => ({ attributes: { name, is_file: true, is_symlink: false } });
const dir = (name) => ({ attributes: { name, is_file: false, is_symlink: false } });
const failure = (detail = "Permission denied") => Object.assign(new Error("Request failed with status code 500"), {
  response: { status: 500, data: { errors: [{ code: "DaemonConnectionException", detail }] } },
});

function harness(tree, options = {}) {
  const gets = [];
  const posts = [];
  const logs = [];
  const logger = Object.fromEntries(["info", "debug"].map((level) => [level, (message) => logs.push(message)]));
  const api = {
    async get(endpoint, { params: { directory } }) {
      gets.push({ endpoint, directory });
      if (options.getError?.(directory)) throw options.getError(directory);
      assert.ok(Object.hasOwn(tree, directory), `Unexpected listing: ${directory}`);
      return { status: 200, data: options.raw ? tree[directory] : { data: tree[directory] } };
    },
    async post(endpoint, body) {
      posts.push({ endpoint, ...body });
      if (options.postError?.(posts.length)) throw options.postError(posts.length);
      return { status: options.postStatus ?? 204 };
    },
  };
  return {
    gets, posts, logs,
    run: (overrides = {}) => deleteAllFilesInDirectory({
      api, logger, serverId: "test", targetPath: "./plugins/MythicMobs/",
      filesType: "whitelist", filesList: ["config/", "data/", "logs/"], ...overrides,
    }),
  };
}

test("production MythicMobs tree preserves config/data, allows missing logs and removes other entries", async () => {
  const names = ["assets", "config", "cutscenes", "data", "dialogs", "droptables", "generation",
    "items", "menus", "mobs", "packs", "randomspawns", "skills", "spawners", "tools", "unit"];
  const tree = { [target]: [...names.map(dir), file("settings.yml"), file(".gitattributes")] };
  for (const name of names.filter((name) => !["config", "data"].includes(name))) {
    tree[`${target}/${name}`] = [file("old.yml"), dir("empty")];
    tree[`${target}/${name}/empty`] = [];
  }
  const h = harness(tree);
  await h.run();
  assert.deepEqual(h.posts, [{
    endpoint: "/api/client/servers/test/files/delete", root: target,
    files: [...names.filter((name) => !["config", "data"].includes(name)), "settings.yml", ".gitattributes"],
  }]);
  assert.equal(h.gets.some(({ directory }) => /\/(config|data|logs)(\/|$)/.test(directory)), false);
});

test("deeply nested protected directories keep all contents and ancestors; empty siblings are removed", async () => {
  const tree = {
    [target]: [dir("config"), dir("packs"), file("old.yml")],
    [`${target}/packs`]: [dir("world"), file("old.yml")],
    [`${target}/packs/world`]: [dir("region"), dir("empty")],
    [`${target}/packs/world/region`]: [dir("data"), dir("logs"), file("old.yml")],
    [`${target}/packs/world/empty`]: [],
  };
  const h = harness(tree);
  await h.run();
  assert.deepEqual(h.posts.map(({ root, files }) => ({ root, files })), [
    { root: `${target}/packs/world/region`, files: ["old.yml"] },
    { root: `${target}/packs/world`, files: ["empty"] },
    { root: `${target}/packs`, files: ["old.yml"] },
    { root: target, files: ["old.yml"] },
  ]);
  assert.equal(h.gets.length, 5);
});

for (const depth of [0, 10, 400]) {
  test(`MythicMobs root-anchored dry-run uses one GET with ${depth} nested directories`, async () => {
    const removable = ["assets", "generation", "mobs", "skills", "settings.yml"];
    const tree = {
      [target]: [dir("config"), dir("data"), ...removable.slice(0, -1).map(dir), file("settings.yml")],
    };
    for (const name of removable.slice(0, -1)) tree[`${target}/${name}`] = [];
    let root = `${target}/generation`;
    tree[root] = [dir("resource_pack")];
    root += "/resource_pack";
    for (let index = 0; index < depth; index++) {
      tree[root] = [dir(`nested-${index}`), dir("config"), dir("data"), dir("logs")];
      root += `/nested-${index}`;
    }
    tree[root] = [dir("data")];
    const h = harness(tree, { postError: () => failure("Dry-run must not delete") });
    await h.run({ dryRun: true, filesList: ["./config/", "./data/", "./logs/"] });
    assert.deepEqual(h.gets, [{ endpoint: "/api/client/servers/test/files/list", directory: target }]);
    assert.deepEqual(h.posts, []);
    const preview = h.logs.filter((line) => line.startsWith("Dry-run files:"));
    assert.equal(preview.length, 1);
    assert.deepEqual(JSON.parse(preview[0].split("; files=")[1]), removable);
  });
}

test("anchored dry-run with no root match stops after one GET without a deletion preview", async () => {
  const h = harness({ [target]: [dir("assets")], [`${target}/assets`]: [dir("data")] });
  await assert.rejects(h.run({ dryRun: true, filesList: ["./config/", "./data/", "./logs/"] }), /Whitelist did not match/);
  assert.equal(h.gets.length, 1);
  assert.deepEqual(h.posts, []);
  assert.equal(h.logs.some((line) => line.startsWith("Dry-run planned")), false);
});

for (const spelling of ["./plugins/MythicMobs/", "plugins/MythicMobs/", "/plugins/MythicMobs/",
  "./plugins/MythicMobs", "plugins/MythicMobs", "/plugins/MythicMobs", "\\plugins\\MythicMobs\\"]) {
  test(`cleanup uses consistent listing/deletion roots for ${spelling}`, async () => {
    const h = harness({ [target]: [dir("data"), file("old.yml")] });
    await h.run({ targetPath: spelling });
    assert.equal(h.gets[0].directory, target);
    assert.equal(h.posts[0].root, target);
    assert.deepEqual(h.posts[0].files, ["old.yml"]);
  });
}

test("root listing HTTP 500 reports operation, endpoint and target; sends no DELETE", async () => {
  const h = harness({}, { getError: () => failure() });
  await assert.rejects(h.run(), (error) => {
    assert.match(error.message, /listing: GET \/api\/client\/servers\/test\/files\/list/);
    assert.match(error.message, /target="\/plugins\/MythicMobs"; directory="\/plugins\/MythicMobs"/);
    assert.match(error.message, /batch_count=0; files=n\/a/);
    assert.match(error.message, /HTTP status=500; details=DaemonConnectionException: Permission denied/);
    assert.match(error.message, /before any deletions/);
    return true;
  });
  assert.equal(h.posts.length, 0);
});

test("nested listing HTTP 500 is distinguished from root listing and prevents all mutations", async () => {
  const h = harness({ [target]: [dir("data"), dir("assets")] }, {
    getError: (directory) => directory.endsWith("/assets") ? failure("Cannot stat assets entry") : null,
  });
  await assert.rejects(h.run(), /listing: GET.*directory="\/plugins\/MythicMobs\/assets".*HTTP status=500/);
  assert.equal(h.posts.length, 0);
});

test("DELETE HTTP 500 reports batch entries and stops without retries or diagnostic deletions", async () => {
  const h = harness({ [target]: [dir("data"), file("one.yml"), file("two.yml")] }, { postError: () => failure() });
  await assert.rejects(h.run(), (error) => {
    assert.match(error.message, /delete: POST.*\/files\/delete/);
    assert.match(error.message, /batch_count=2; files=\["one.yml","two.yml"\]/);
    assert.match(error.message, /HTTP status=500/);
    assert.match(error.message, /partially deleted; it was not retried/);
    return true;
  });
  assert.equal(h.posts.length, 1);
});

test("explicit batch limit bounds each request without changing protected paths", async () => {
  const files = Array.from({ length: 101 }, (_, index) => `old-${index}.yml`);
  const h = harness({ [target]: [dir("config"), dir("data"), dir("logs"), ...files.map(file)] });
  await h.run({ deleteBatchSize: 5 });
  assert.equal(h.posts.length, 21);
  assert.ok(h.posts.every(({ files }) => files.length > 0 && files.length <= 5));
  assert.deepEqual(h.posts.flatMap(({ files }) => files), files);
});

test("failed second batch prevents remaining batches and ancestor deletions", async () => {
  const h = harness({
    [target]: [dir("packs"), file("root.yml")],
    [`${target}/packs`]: [dir("data"), file("a.yml"), file("b.yml"), file("c.yml")],
  }, { postError: (number) => number === 2 ? failure("Cannot unlink b.yml") : null });
  await assert.rejects(h.run({ deleteBatchSize: 1 }), /files=\["b.yml"\].*Cannot unlink b.yml/);
  assert.deepEqual(h.posts.map(({ files }) => files), [["a.yml"], ["b.yml"]]);
  assert.equal(h.logs.some((line) => line === "Deleted 1 items from /plugins/MythicMobs"), false);
});

test("non-204 DELETE is not reported as completed", async () => {
  const h = harness({ [target]: [dir("data"), file("old.yml")] }, { postStatus: 200 });
  await assert.rejects(h.run(), /HTTP status=200.*Expected HTTP 204/);
  assert.equal(h.logs.some((line) => line.startsWith("Deleted ")), false);
});

test("malformed listings and invalid names stop before mutations with GET context", async () => {
  for (const items of [{}, null, [{ attributes: { name: "../data", is_file: true } }],
    [{ attributes: { name: "data" } }], [file("old"), file("old")],
    [{ attributes: { name: "data", is_file: false, is_symlink: "true" } }],
    [{ attributes: { name: "data", is_file: false, is_directory: false } }]]) {
    const h = harness({ [target]: items });
    await assert.rejects(h.run(), /listing: GET.*HTTP status=200/);
    assert.equal(h.posts.length, 0);
  }
});

test("a raw-array listing is supported", async () => {
  const h = harness({ [target]: [dir("data"), file("old.yml")] }, { raw: true });
  await h.run();
  assert.deepEqual(h.posts[0].files, ["old.yml"]);
});

test("empty or unmatched whitelist fails before any deletion; empty directory is a harmless no-op", async () => {
  const h = harness({ [target]: [file("old.yml")] });
  await assert.rejects(h.run(), /Whitelist did not match/);
  await assert.rejects(h.run({ filesList: [] }), /Whitelist is empty/);
  assert.equal(h.posts.length, 0);
  const empty = harness({ [target]: [] });
  await empty.run();
  assert.equal(empty.posts.length, 0);
});

test("diagnostics redact credentials and signed URLs and bound batch summaries", async () => {
  const secret = "test-super-secret-key";
  const h = harness({ [target]: [dir("data"), ...Array.from({ length: 30 }, (_, index) => file(`old-${index}.yml`))] }, {
    postError: () => failure(`Permission denied. Bearer ${secret} https://agent.invalid/upload?token=signed-secret "password": "hidden-pass" Basic encoded-credentials`),
  });
  await assert.rejects(h.run({ secrets: [secret] }), (error) => {
    assert.match(error.message, /batch_count=30/);
    assert.match(error.message, /\(\+20 more\)/);
    assert.doesNotMatch(error.message, /test-super-secret-key|signed-secret|agent\.invalid|hidden-pass|encoded-credentials/);
    assert.ok(error.message.length < 2000);
    return true;
  });
  assert.doesNotMatch(h.logs.join("\n"), /test-super-secret-key|signed-secret/);
});

test("network failures and opaque HTML bodies do not expose request config or response body", async () => {
  for (const error of [new Error("connect failed https://user:pass@panel.invalid?token=secret"),
    Object.assign(new Error("Request failed with status code 500"), {
      response: { status: 500, data: "<html>secret-token</html>" },
      config: { headers: { Authorization: "Bearer secret-token" } },
    })]) {
    const h = harness({}, { getError: () => error });
    await assert.rejects(h.run(), (failure) => {
      assert.doesNotMatch(failure.message, /secret-token|panel\.invalid|user:pass/);
      assert.match(failure.message, /listing: GET/);
      return true;
    });
  }
});

test("invalid batch sizes and parent traversal paths fail before any requests", async () => {
  for (const deleteBatchSize of [-1, 1.5, Infinity]) {
    const h = harness({});
    await assert.rejects(h.run({ deleteBatchSize }), /delete-batch-size/);
    assert.equal(h.gets.length, 0);
  }
  const h = harness({});
  await assert.rejects(h.run({ targetPath: "plugins/../other/" }), /containing '\.\.'/);
  assert.equal(h.gets.length, 0);
});

test("dry-run includes every planned file, preserves whitelist and sends no DELETE", async () => {
  const files = Array.from({ length: 25 }, (_, index) => `old-${index}.yml`);
  const h = harness({ [target]: [dir("config"), dir("data"), ...files.map(file)] }, { postError: () => failure() });
  await h.run({ dryRun: true });
  assert.deepEqual(h.posts, []);
  assert.match(h.logs.join("\n"), /Dry-run planned delete: POST.*batch_count=25/);
  const preview = h.logs.filter((line) => line.startsWith("Dry-run files:"));
  assert.equal(preview.length, 3);
  assert.deepEqual(preview.flatMap((line) => JSON.parse(line.split("; files=")[1])), files);
  assert.equal(h.logs.some((line) => line.startsWith("Deleted ")), false);
});

test("dry-run preserves the fail-closed whitelist rule", async () => {
  const h = harness({ [target]: [file("old.yml")] });
  await assert.rejects(h.run({ dryRun: true }), /Whitelist did not match/);
  assert.deepEqual(h.posts, []);
  assert.equal(h.logs.some((line) => line.startsWith("Dry-run planned")), false);
});
