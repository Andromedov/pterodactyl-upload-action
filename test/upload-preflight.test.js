const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { prepareUploads, validateZip } = require("../src/upload-preflight");
const zipFixtures = require("./fixtures/zip.json");
// Fixtures were created with Python zipfile (ZIP_STORED/ZIP_DEFLATED),
// independently of the validator, with contents/ and contents/config.yml.

for (const type of ["stored", "deflated"]) {
  test(`ZIP preflight accepts ${type} entries, including directory entries`, async () => {
    await validateZip(Buffer.from(zipFixtures[type], "base64"));
  });
}

test("preflight snapshots all sources and config.targets before files change", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "upload-preflight-"));
  try {
    const source = path.join(tempDir, "deploy.zip");
    const other = path.join(tempDir, "settings.yml");
    const archive = Buffer.from(zipFixtures.deflated, "base64");
    await fs.writeFile(source, archive);
    await fs.writeFile(other, "before: true");
    const uploads = await prepareUploads({
      sourceListPath: [source, other], targetPath: "./plugins/MythicMobs/", followSymbolicLinks: true,
      targets: [{ source, target: "/plugins/Other/copy.zip" }],
    });
    await fs.unlink(source);
    await fs.writeFile(other, "after: true");
    assert.equal(uploads.length, 3);
    assert.deepEqual(uploads.map(({ targetFile }) => targetFile),
      ["/plugins/MythicMobs/deploy.zip", "/plugins/MythicMobs/settings.yml", "/plugins/Other/copy.zip"]);
    assert.deepEqual(uploads[0].buffer, archive);
    assert.equal(uploads[1].buffer.toString(), "before: true");
    assert.strictEqual(uploads[0].buffer, uploads[2].buffer);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("preflight checks ZIP content when a non-ZIP source is renamed to ZIP", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "upload-preflight-"));
  try {
    const source = path.join(tempDir, "input.bin");
    await fs.writeFile(source, "not a ZIP");
    await assert.rejects(prepareUploads({ sourceListPath: [source], targetPath: "/deploy.zip", targets: [] }),
      /Cannot prepare source.*cleanup not started/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
