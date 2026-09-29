const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

test("action exits after a successful upload despite an open Node handle", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pterodactyl-action-"));
  const source = path.join(tempDir, "deploy.txt");
  await fs.writeFile(source, "deployment data");

  let uploaded = false;
  let baseUrl;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/client/servers/test/files/upload") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ attributes: { url: `${baseUrl}/signed-upload` } }));
      return;
    }
    if (request.url?.startsWith("/signed-upload")) {
      for await (const chunk of request) {
        if (chunk.includes(Buffer.from("deployment data"))) uploaded = true;
      }
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const actionPath = path.resolve(__dirname, "../dist/index.js");
    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000); require(process.argv[1]);",
      actionPath,
    ], {
      env: {
        ...process.env,
        "INPUT_PANEL-HOST": baseUrl,
        "INPUT_API-KEY": "test-key",
        "INPUT_SERVER-ID": "test",
        INPUT_SOURCE: source,
        INPUT_TARGET: "./plugins/CustomFishing/",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timeout = setTimeout(() => child.kill(), 5000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      assert.equal(code, 0, output);
      assert.equal(uploaded, true);
      assert.match(output, /Done/);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
