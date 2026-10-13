const { collectDeletionPlan, validateListing } = require("./file-filter");
const { normalizeServerPath } = require("./server-path");

function safeText(value, secrets, limit = 500) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[redacted]");
  }
  // Error details can echo credentials or signed URLs. Never log request
  // configs, response headers, full response objects or arbitrary HTML bodies.
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, "[URL redacted]")
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [redacted]")
    .replace(/\b(token|api[-_]?key|authorization|password|signature)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;"'<>]+)/gi, "$1=[redacted]");
  text = text.replace(/[\x00-\x1f\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function apiDetails(error, secrets) {
  const data = error.response?.data;
  const details = Array.isArray(data?.errors)
    ? data.errors.slice(0, 3).map((item) =>
      [item?.code, item?.detail].filter((value) => typeof value === "string")
        .map((value) => safeText(value, secrets, 200)).join(": ")).filter(Boolean)
    : [data?.error, data?.message].filter((value) => typeof value === "string")
      .map((value) => safeText(value, secrets, 200));
  return details.length ? details.join("; ") : safeText(error.message || "No API error details provided", secrets);
}

async function deleteAllFilesInDirectory({
  api, logger, serverId, targetPath, filesType = "blacklist", filesList = [],
  deleteBatchSize = 0, secrets = [], dryRun = false,
}) {
  if (!Number.isSafeInteger(deleteBatchSize) || deleteBatchSize < 0) {
    throw new Error("delete-batch-size must be a nonnegative integer (0 keeps one batch per directory)");
  }
  const target = normalizeServerPath(targetPath);
  const endpointRoot = `/api/client/servers/${encodeURIComponent(serverId)}/files`;
  const safe = (value, limit) => safeText(value, secrets, limit);
  const describe = ({ operation, method, endpoint, directory, files }) => {
    const names = files?.slice(0, 10).map((name) => safe(name, 80));
    const summary = names ? `${JSON.stringify(names)}${files.length > names.length ? ` (+${files.length - names.length} more)` : ""}` : "n/a";
    return `${operation}: ${method} ${safe(endpoint)}; target=${JSON.stringify(safe(target))}; ` +
      `directory=${JSON.stringify(safe(directory))}; batch_count=${files?.length ?? 0}; files=${summary}`;
  };

  async function request(context, operation) {
    const description = describe(context);
    let status;
    if (context.operation === "delete") logger.info(`Cleanup ${description}`);
    else logger.debug(`Cleanup ${description}`);
    try {
      const response = await operation();
      status = response.status;
      if (context.operation === "listing") {
        const items = Array.isArray(response.data) ? response.data : response.data?.data;
        return validateListing(items, context.directory);
      }
      if (response.status !== 204) throw new Error("Expected HTTP 204 confirming deletion");
    } catch (error) {
      const failureStatus = error.response?.status ?? status ?? "unavailable";
      const safety = context.operation === "delete"
        ? "Batch may have been partially deleted; it was not retried. Cleanup incomplete; upload stopped."
        : "Cleanup planning stopped before any deletions; upload stopped.";
      throw new Error(`Cleanup ${description} failed; HTTP status=${failureStatus}; details=${apiDetails(error, secrets)}. ${safety}`);
    }
  }

  logger.info(`${dryRun ? "Planning cleanup (dry-run)" : "Deleting files"} in ${safe(targetPath)} on server ${safe(serverId)} with ${safe(filesType)} mode`);
  // Finish all listing, schema validation and whitelist checks before the
  // first mutation. Failed listing must never become an empty directory.
  const operations = await collectDeletionPlan((directory) => request({
    operation: "listing", method: "GET", endpoint: `${endpointRoot}/list`, directory,
  }, () => api.get(`${endpointRoot}/list`, { params: { directory } })), target, filesType, filesList);

  for (const { root, files } of operations) {
    const size = deleteBatchSize || files.length;
    for (let offset = 0; offset < files.length; offset += size) {
      const batch = files.slice(offset, offset + size);
      if (dryRun) {
        logger.info(`Dry-run planned ${describe({ operation: "delete", method: "POST", endpoint: `${endpointRoot}/delete`, directory: root, files: batch })}`);
        for (let index = 0; index < batch.length; index += 10) {
          logger.info(`Dry-run files: directory=${JSON.stringify(safe(root))}; files=${JSON.stringify(batch.slice(index, index + 10).map((name) => safe(name, 256)))}`);
        }
        continue;
      }
      await request({
        operation: "delete", method: "POST", endpoint: `${endpointRoot}/delete`, directory: root, files: batch,
      }, () => api.post(`${endpointRoot}/delete`, { root, files: batch }));
      logger.info(`Deleted ${batch.length} items from ${safe(root)}`);
    }
  }
  if (!operations.length) logger.info(`No files to delete after applying ${safe(filesType)} filter`);
}

module.exports = { deleteAllFilesInDirectory };
