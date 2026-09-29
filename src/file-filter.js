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

function isDirectory(attributes) {
  if (attributes.is_symlink === true) return false;
  if (typeof attributes.is_directory === "boolean") return attributes.is_directory;
  if (typeof attributes.is_file === "boolean") return !attributes.is_file;
  throw new Error(`Cannot determine file type for ${attributes.name}`);
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
    let matchesFound = 0;

    for (const item of items) {
      const attributes = item.attributes || item;
      const { name } = attributes;
      const itemIsDirectory = isDirectory(attributes);
      const relativePath = path.posix.join(relativeDirectory, name);
      const serverPath = path.posix.join(basePath, relativePath);
      const matches = filesList.some((pattern) =>
        matchesPattern(name, relativePath, serverPath, itemIsDirectory, pattern)
      );

      if (mode === "blacklist") {
        if (matches) {
          namesToDelete.push(name);
        } else if (itemIsDirectory) {
          const child = await visit(`${path.posix.join(directory, name)}/`, relativePath);
          operations.push(...child.operations);
        }
        continue;
      }

      if (matches) {
        hasKeptItem = true;
        matchesFound++;
      } else if (itemIsDirectory && mayContainMatch(relativePath, serverPath, filesList)) {
        const child = await visit(`${path.posix.join(directory, name)}/`, relativePath);
        matchesFound += child.matchesFound;
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
    return { hasKeptItem, matchesFound, operations };
  }

  const plan = await visit(targetPath, "");
  if (mode === "whitelist" && filesList.length > 0 &&
      plan.operations.length > 0 && plan.matchesFound === 0) {
    throw new Error("Whitelist did not match any server files; deletion stopped");
  }
  return plan.operations;
}

module.exports = { collectDeletionPlan };
