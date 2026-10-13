const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zipFixtures = require("./fixtures/zip.json");

async function runAction(targetPath, failingOperation, options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "action-cleanup-"));
  await fs.writeFile(path.join(tempDir, "deploy.zip"), options.archive ?? Buffer.from(zipFixtures.stored, "base64"));
  if (options.config) await fs.writeFile(path.join(tempDir, ".pterodactyl-upload.json"), JSON.stringify(options.config));
  const calls = [];
  let baseUrl;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, baseUrl);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();
    const body = request.headers["content-type"]?.includes("application/json") ? JSON.parse(rawBody) : rawBody;
    calls.push({ method: request.method, endpoint: url.pathname, directory: url.searchParams.get("directory"), body });
    response.setHeader("Content-Type", "application/json");
    if ((failingOperation === "listing" && url.pathname.endsWith("/list") && url.searchParams.get("directory").endsWith("/assets")) ||
        (failingOperation === "delete" && url.pathname.endsWith("/delete"))) {
      response.statusCode = 500;
      response.end(JSON.stringify({ errors: [{ code: "FatalError", detail: "Mock filesystem failure" }] }));
    } else if (url.pathname.endsWith("/list")) {
      const names = url.searchParams.get("directory").endsWith("/assets")
        ? [{ name: "old.yml", is_file: true }]
        : [{ name: "config", is_file: false }, { name: "data", is_file: false },
          { name: "assets", is_file: false }, { name: "old.yml", is_file: true }];
      response.end(JSON.stringify({ data: names.map((attributes) => ({ attributes })) }));
    } else if (url.pathname.endsWith("/files/upload")) {
      response.end(JSON.stringify({ attributes: { url: `${baseUrl}/upload/file?token=mock-signature` } }));
    } else if (url.pathname === "/upload/file") {
      assert.equal(request.headers.authorization, undefined);
      response.statusCode = 204;
      response.end();
    } else {
      response.statusCode = 204;
      response.end();
    }
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, [path.resolve(__dirname, "../dist/index.js")], {
      cwd: tempDir,
      env: {
        ...process.env,
        "INPUT_PANEL-HOST": baseUrl,
        "INPUT_API-KEY": "mock-key",
        "INPUT_SERVER-ID": "test",
        "INPUT_SERVER-IDS": "",
        INPUT_SOURCE: "deploy.zip",
        INPUT_SOURCES: "",
        INPUT_TARGET: targetPath,
        "INPUT_DELETE-FILES-IN-DIR": "true",
        "INPUT_FILES-TYPE": "whitelist",
        "INPUT_FILES-LIST": "config/, data/, logs/",
        "INPUT_DELETE-BATCH-SIZE": "1",
        "INPUT_DECOMPRESS-TARGET": "true",
        INPUT_COMMAND: "mythicmobs reload",
        INPUT_RESTART: "false",
        INPUT_PROXY: "",
        "INPUT_CLEANUP-DRY-RUN": "false",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timeout = setTimeout(() => child.kill(), 10000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { code, output, calls };
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

for (const [name, options] of [
  ["missing ZIP", { env: { INPUT_SOURCE: "missing.zip" } }],
  ["empty glob", { env: { INPUT_SOURCE: "missing-*.zip" } }],
  ["unreadable-as-file directory", { env: { INPUT_SOURCE: "." } }],
  ["malformed ZIP", { archive: Buffer.from("not a zip") }],
  ["truncated ZIP", { archive: Buffer.from(zipFixtures.stored, "base64").subarray(0, 100) }],
  ["missing later source", { env: { INPUT_SOURCES: "deploy.zip\nmissing.zip" } }],
  ["missing config.targets source", { config: { targets: [{ source: "missing.zip", target: "./plugins/Other/" }] } }],
]) {
  test(`preflight rejects ${name} before any server requests`, async () => {
    const { code, output, calls } = await runAction("./plugins/MythicMobs/", undefined, options);
    assert.equal(code, 1, output);
    assert.match(output, /cleanup not started/);
    assert.doesNotMatch(output, /Done|Deleting files/);
    assert.deepEqual(calls, []);
  });
}

test("ZIP with damaged payload fails CRC preflight before cleanup", async () => {
  const archive = Buffer.from(zipFixtures.stored, "base64");
  archive[archive.indexOf("mock archive data")] ^= 1;
  const { code, output, calls } = await runAction("./plugins/MythicMobs/", undefined, { archive });
  assert.equal(code, 1, output);
  assert.match(output, /ZIP CRC-32 mismatch/);
  assert.deepEqual(calls, []);
});

test("dry-run prints cleanup for every server and performs no mutations or deployment", async () => {
  const { code, output, calls } = await runAction("./plugins/MythicMobs/", undefined, {
    env: { "INPUT_CLEANUP-DRY-RUN": "true", "INPUT_SERVER-IDS": "test\nsecond", INPUT_RESTART: "true" },
  });
  assert.equal(code, 0, output);
  assert.match(output, /Preflight checked 1 upload files/);
  assert.match(output, /Dry-run planned delete: POST/);
  assert.match(output, /files=\["assets"\]/);
  assert.match(output, /files=\["old.yml"\]/);
  assert.match(output, /Cleanup dry-run complete; no deployment performed/);
  assert.doesNotMatch(output, /Done|Deleted \d|Successfully deleted|Uploading/);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ method, endpoint }) => method === "GET" && endpoint.endsWith("/list")));
});

test("dry-run with listing failure fails without mutations", async () => {
  const { code, output, calls } = await runAction("./plugins/MythicMobs/", "listing", {
    env: { "INPUT_CLEANUP-DRY-RUN": "true" },
  });
  assert.equal(code, 1, output);
  assert.match(output, /HTTP status=500/);
  assert.doesNotMatch(output, /Cleanup dry-run complete/);
  assert.ok(calls.every(({ method }) => method === "GET"));
});

test("distributed root-anchored dry-run needs one GET and never lists assets", async () => {
  // The mock returns HTTP 500 for assets: an accidental recursive listing
  // must fail this test rather than silently preserving the old traversal.
  const { code, output, calls } = await runAction("./plugins/MythicMobs/", "listing", {
    env: { "INPUT_CLEANUP-DRY-RUN": "true", "INPUT_FILES-LIST": "./config/, ./data/, ./logs/" },
  });
  assert.equal(code, 0, output);
  assert.match(output, /files=\["assets"\]/);
  assert.match(output, /files=\["old.yml"\]/);
  assert.match(output, /Cleanup dry-run complete; no deployment performed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].endpoint, "/api/client/servers/test/files/list");
  assert.equal(calls[0].directory, "/plugins/MythicMobs");
});

test("dry-run requires enabled directory cleanup", async () => {
  for (const [targetPath, env] of [["./plugins/MythicMobs/", { "INPUT_DELETE-FILES-IN-DIR": "false" }],
    ["./plugins/MythicMobs/deploy.zip", {}]]) {
    const { code, output, calls } = await runAction(targetPath, undefined, {
      env: { "INPUT_CLEANUP-DRY-RUN": "true", ...env },
    });
    assert.equal(code, 1, output);
    assert.match(output, /cleanup-dry-run requires/);
    assert.deepEqual(calls, []);
  }
});

for (const spelling of ["./plugins/MythicMobs/", "plugins/MythicMobs/", "/plugins/MythicMobs/", "./"]) {
  test(`distributed action uses server POSIX paths throughout deployment for ${spelling}`, async () => {
    const { code, output, calls } = await runAction(spelling);
    const root = spelling === "./" ? "/" : "/plugins/MythicMobs";
    assert.equal(code, 0, output);
    assert.match(output, /Done/);
    assert.deepEqual(calls.filter(({ endpoint }) => endpoint.endsWith("/list")).map(({ directory }) => directory),
      [root, `${root.replace(/\/$/, "")}/assets`]);
    const deletes = calls.filter(({ endpoint }) => endpoint.endsWith("/delete"));
    assert.deepEqual(deletes.map(({ body }) => body), [
      { root, files: ["assets"] }, { root, files: ["old.yml"] }, { root, files: ["deploy.zip"] },
    ]);
    const upload = calls.find(({ endpoint }) => endpoint === "/upload/file");
    assert.equal(upload.directory, root);
    assert.match(upload.body, /mock archive data/);
    assert.match(upload.body, /filename="deploy.zip"/);
    assert.deepEqual(calls.find(({ endpoint }) => endpoint.endsWith("/decompress")).body, { root, file: "deploy.zip" });
    assert.deepEqual(calls.at(-1).body, { command: "mythicmobs reload" });
  });
}

for (const operation of ["listing", "delete"]) {
  test(`distributed action fails on cleanup ${operation} HTTP 500 and never starts upload`, async () => {
    const { code, output, calls } = await runAction("./plugins/MythicMobs/", operation);
    assert.equal(code, 1, output);
    assert.match(output, new RegExp(`Cleanup ${operation}: ${operation === "listing" ? "GET" : "POST"}`));
    assert.match(output, /HTTP status=500; details=FatalError: Mock filesystem failure/);
    assert.doesNotMatch(output, /Done|Successfully deleted|mock-signature/);
    assert.equal(calls.some(({ endpoint }) => /upload|decompress|command|power/.test(endpoint)), false);
    assert.equal(calls.filter(({ endpoint }) => endpoint.endsWith("/delete")).length, operation === "listing" ? 0 : 1);
  });
}
