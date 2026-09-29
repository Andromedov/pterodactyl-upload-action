const path = require("path");
const { minimatch } = require("minimatch");

function normalizePattern(pattern) {
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  return normalized.startsWith("*/") ? `**/${normalized.slice(2)}` : normalized;
}

function matchesPattern(name, relativePath, serverPath, isDirectory, pattern) {
  const normalized = normalizePattern(pattern);
  const directoryOnly = normalized.endsWith("/");
  const match = directoryOnly ? normalized.slice(0, -1) : normalized;
  if (!match || (directoryOnly && !isDirectory)) return false;

  const options = { dot: true };
  return match.includes("/")
    ? minimatch(relativePath, match, options) || minimatch(serverPath, match, options)
    : minimatch(name, match, options);
}

function mayContainMatch(relativePath, serverPath, patterns) {
  return patterns.some((pattern) => {
    const normalized = normalizePattern(pattern);
    const match = normalized.replace(/\/$/, "");
    if (!match.includes("/")) return true;
    const parts = match.split("/");
    for (let length = 1; length < parts.length; length++) {
      const prefix = parts.slice(0, length).join("/");
      if (minimatch(relativePath, prefix, { dot: true }) ||
          minimatch(serverPath, prefix, { dot: true })) return true;
    }
    return false;
  });
}

async function collectDeletionPlan(listDirectory, targetPath, filesType, filesList) {
  const mode = filesType.toLowerCase();
  if (mode !== "whitelist" && mode !== "blacklist") {
    throw new Error("files-type must be whitelist or blacklist");
  }
  if (mode === "blacklist" && filesList.length === 0) return [];

  const basePath = path.posix.normalize(targetPath.replace(/\\/g, "/"));

  async function visit(directory, relativeDirectory) {
    const items = await listDirectory(directory);
    const operations = [];
    const namesToDelete = [];
    let hasKeptItem = false;

    for (const item of items) {
      const attributes = item.attributes || item;
      const { name } = attributes;
      const isDirectory = attributes.is_directory;
      const relativePath = path.posix.join(relativeDirectory, name);
      const serverPath = path.posix.join(basePath, relativePath);
      const matches = filesList.some((pattern) =>
        matchesPattern(name, relativePath, serverPath, isDirectory, pattern)
      );

      if (mode === "blacklist") {
        if (matches) {
          namesToDelete.push(name);
        } else if (isDirectory) {
          const child = await visit(`${path.posix.join(directory, name)}/`, relativePath);
          operations.push(...child.operations);
        }
        continue;
      }

      if (matches) {
        hasKeptItem = true;
      } else if (isDirectory && mayContainMatch(relativePath, serverPath, filesList)) {
        const child = await visit(`${path.posix.join(directory, name)}/`, relativePath);
        if (child.hasKeptItem) {
          hasKeptItem = true;
          operations.push(...child.operations);
        } else {
          namesToDelete.push(name);
        }
      } else {
        namesToDelete.push(name);
      }
    }

    if (namesToDelete.length > 0) {
      operations.push({ root: directory, files: namesToDelete });
    }
    return { hasKeptItem, operations };
  }

  return (await visit(targetPath, "")).operations;
}

module.exports = { collectDeletionPlan };
