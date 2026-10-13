const path = require("path");
const { Minimatch } = require("minimatch");
const { normalizeServerPath } = require("./server-path");

const matchOptions = { dot: true, nonegate: true, nocomment: true };

function parseFilesList(value) {
  const patterns = [];
  let start = 0;
  const groups = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const closing = { "{": "}", "[": "]", "(": ")" }[character];
    if (closing && groups[groups.length - 1] !== "]") groups.push(closing);
    else if (character === groups[groups.length - 1]) groups.pop();
    else if (character === "," && groups.length === 0) {
      patterns.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  patterns.push(value.slice(start).trim());
  return patterns.filter(Boolean);
}

function compilePattern(pattern) {
  if (typeof pattern !== "string") throw new Error("File patterns must be strings");
  const spelling = pattern.trim().replace(/\\/g, "/");
  const rootAnchored = spelling.startsWith("./");
  let normalized = spelling.replace(/^(?:\.\/|\/)+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("File patterns must be nonempty and cannot contain NUL or '..'");
  }
  // Preserve the legacy any-depth shorthand only for unanchored patterns.
  if (!rootAnchored && normalized.startsWith("*/")) normalized = `**/${normalized.slice(2)}`;
  const directoryOnly = normalized.endsWith("/");
  const match = directoryOnly ? normalized.slice(0, -1) : normalized;
  return { rootAnchored, directoryOnly, hasPath: match.includes("/"),
    matcher: new Minimatch(match, matchOptions) };
}

function matchesPattern(name, relativePath, serverPath, isDirectory, pattern) {
  const { rootAnchored, directoryOnly, hasPath, matcher } = pattern;
  if (directoryOnly && !isDirectory) return false;
  if (rootAnchored) return matcher.match(relativePath);

  return hasPath
    ? matcher.match(relativePath) || matcher.match(serverPath)
    : matcher.match(name);
}

function mayContainMatch(relativePath, serverPath, patterns) {
  return patterns.some((pattern) => {
    const { rootAnchored, hasPath, matcher } = pattern;
    if (!rootAnchored && !hasPath) return true;
    // Let minimatch expand braces/globstars before testing prefixes. Splitting
    // the raw pattern on '/' can miss protected paths like {a/b,c/d}/keep.yml.
    return matcher.match(relativePath, true) || (!rootAnchored && matcher.match(serverPath, true));
  });
}

function isDirectory(attributes) {
  if (attributes.is_symlink === true) return false;
  if (typeof attributes.is_directory === "boolean") return attributes.is_directory;
  if (typeof attributes.is_file === "boolean") return !attributes.is_file;
  throw new Error(`Cannot determine file type for ${attributes.name}`);
}

function validateListing(items, directory) {
  if (!Array.isArray(items)) throw new Error(`Invalid file listing for ${JSON.stringify(directory)}: expected an array`);
  const seen = new Set();
  for (const item of items) {
    const attributes = item?.attributes ?? item;
    const name = attributes?.name;
    if (typeof name !== "string" || !name || name === "." || name === ".." || /[/\\\0]/.test(name)) {
      throw new Error(`Invalid file name in listing for ${JSON.stringify(directory)}: expected a single path component`);
    }
    if (seen.has(name)) throw new Error(`Duplicate file name ${JSON.stringify(name)} in ${JSON.stringify(directory)}`);
    seen.add(name);
    for (const field of ["is_file", "is_directory", "is_symlink"]) {
      if (field in attributes && typeof attributes[field] !== "boolean") {
        throw new Error(`Invalid ${field} for ${JSON.stringify(name)} in ${JSON.stringify(directory)}: expected a boolean`);
      }
    }
    if (typeof attributes.is_directory === "boolean" && typeof attributes.is_file === "boolean" &&
        attributes.is_directory === attributes.is_file && attributes.is_symlink !== true) {
      throw new Error(`Conflicting file type for ${JSON.stringify(name)} in ${JSON.stringify(directory)}`);
    }
    isDirectory(attributes);
  }
  return items;
}

async function collectDeletionPlan(listDirectory, targetPath, filesType, filesList) {
  const mode = filesType.toLowerCase();
  if (mode !== "whitelist" && mode !== "blacklist") {
    throw new Error("files-type must be whitelist or blacklist");
  }
  if (mode === "whitelist" && filesList.length === 0) {
    throw new Error("Whitelist is empty; deletion stopped");
  }
  filesList = filesList.map(compilePattern);
  if (mode === "blacklist" && filesList.length === 0) return [];

  const basePath = normalizeServerPath(targetPath);

  async function visit(directory, relativeDirectory) {
    const items = validateListing(await listDirectory(directory), directory);
    const operations = [];
    const namesToDelete = [];
    let hasKeptItem = false;
    let matchesFound = 0;

    for (const item of items) {
      const attributes = item.attributes || item;
      const { name } = attributes;
      const itemIsDirectory = isDirectory(attributes);
      const relativePath = path.posix.join(relativeDirectory, name);
      const serverPath = path.posix.join(basePath, relativePath).replace(/^\//, "");
      const matches = filesList.some((pattern) =>
        matchesPattern(name, relativePath, serverPath,
          itemIsDirectory || (mode === "whitelist" && attributes.is_symlink === true), pattern)
      );

      if (mode === "blacklist") {
        if (matches) {
          namesToDelete.push(name);
        } else if (itemIsDirectory) {
          const child = await visit(path.posix.join(directory, name), relativePath);
          for (const operation of child.operations) operations.push(operation);
        }
        continue;
      }

      if (matches) {
        hasKeptItem = true;
        matchesFound++;
      } else if (attributes.is_symlink === true && filesList.some((pattern) =>
        pattern.hasPath && mayContainMatch(relativePath, serverPath, [pattern]))) {
        throw new Error(`Cannot verify whitelist descendants through symbolic link ${JSON.stringify(serverPath)}; deletion stopped`);
      } else if (itemIsDirectory && mayContainMatch(relativePath, serverPath, filesList)) {
        const child = await visit(path.posix.join(directory, name), relativePath);
        matchesFound += child.matchesFound;
        if (child.hasKeptItem) {
          hasKeptItem = true;
          for (const operation of child.operations) operations.push(operation);
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

  const plan = await visit(basePath, "");
  if (mode === "whitelist" && filesList.length > 0 &&
      plan.operations.length > 0 && plan.matchesFound === 0) {
    throw new Error("Whitelist did not match any server files; deletion stopped");
  }
  return plan.operations;
}

module.exports = { collectDeletionPlan, validateListing, parseFilesList };
