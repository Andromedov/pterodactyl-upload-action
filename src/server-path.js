const path = require("path");

// These are paths within the game server, never paths on the runner's OS.
function normalizeServerPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error("Server path must be a nonempty string without NUL characters");
  }
  const posixPath = value.replace(/\\/g, "/");
  if (posixPath.split("/").includes("..")) {
    throw new Error("Server paths containing '..' are not allowed");
  }
  return path.posix.resolve("/", posixPath);
}

module.exports = { normalizeServerPath };
