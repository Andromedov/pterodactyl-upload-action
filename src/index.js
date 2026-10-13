const core = require("@actions/core");
const axios = require("axios").default;
const fs = require("fs").promises;
const path = require("path");
const tunnel = require("tunnel");
const FormData = require("form-data");
const { deleteAllFilesInDirectory } = require("./directory-cleanup");
const { normalizeServerPath } = require("./server-path");
const { parseFilesList } = require("./file-filter");
const { prepareUploads } = require("./upload-preflight");

axios.defaults.headers.common.Accept = "application/json";

async function main() {
  try {
    const settings = await getSettings();
    configureAxios(settings.panelHost, settings.apiKey, settings.proxy);

    const {
      serverIds,
      targetPath,
      restart,
      command,
      decompressTarget,
    } = settings;

    const uploads = await prepareUploads(settings);
    core.info(`Preflight checked ${uploads.length} upload files before cleanup`);

    for (const serverId of serverIds) {
      core.debug(`Processing server ${serverId}`);
      if (settings.deleteFilesInDir && targetPath.endsWith("/")) {
        await deleteAllFilesInDirectory({
          api: axios, logger: core, serverId, targetPath,
          filesType: settings.filesType, filesList: settings.filesList,
          deleteBatchSize: settings.deleteBatchSize, secrets: [settings.apiKey, settings.proxy],
          dryRun: settings.cleanupDryRun,
        });
      }
      if (settings.cleanupDryRun) continue;

      for (const { source, targetFile, buffer } of uploads) {
        core.debug(`Processing source ${source}`);

        await uploadFile(serverId, targetFile, buffer);

        if (decompressTarget && isArchiveFile(targetFile)) {
          await decompressFile(serverId, targetFile);
          await deleteFile(serverId, targetFile);
        }
      }

      if (command != "") await sendConsoleCommand(serverId, command);
      if (restart) await restartServer(serverId);
    }

    core.info(settings.cleanupDryRun ? "Cleanup dry-run complete; no deployment performed" : "Done");
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function getSettings() {
  const panelHost = getInput("panel-host", { required: true });
  const apiKey = getInput("api-key", { required: true });
  core.setSecret(apiKey);
  const restart = getInput("restart") == "true";
  const command = getInput("command");
  const proxy = getInput("proxy");
  const decompressTarget = getInput("decompress-target") == "true";
  const deleteFilesInDir = getInput("delete-files-in-dir") == "true";
  const cleanupDryRun = getInput("cleanup-dry-run") == "true";
  const followSymbolicLinks = getInput("follow-symbolic-links") == "true";
  const filesType = getInput("files-type") || "blacklist";
  const filesListRaw = getInput("files-list");
  const filesList = parseFilesList(filesListRaw);
  const deleteBatchSize = Number(getInput("delete-batch-size") || "0");
  if (!Number.isSafeInteger(deleteBatchSize) || deleteBatchSize < 0) {
    throw new Error("delete-batch-size must be a nonnegative integer");
  }

  let sourcePath = getInput("source");
  let sourceListPath = getMultilineInput("sources");
  let targetPath = getInput("target");
  let serverIdInput = getInput("server-id");
  let serverIds = getMultilineInput("server-ids");

  // Debug print out all the inputs
  core.debug(`restart: ${restart}`);
  core.debug(`command: ${command}`);
  core.debug(`source: ${sourcePath}`);
  core.debug(`sources: ${sourceListPath}`);
  core.debug(`target: ${targetPath}`);
  core.debug(`server-id: ${serverIdInput}`);
  core.debug(`server-ids: ${serverIds}`);

  const config = await readConfigFile();

  sourcePath = sourcePath || config.source || "";
  sourceListPath = sourceListPath.length
    ? sourceListPath
    : config.sources || [];
  targetPath = targetPath || config.target || "";
  serverIdInput = serverIdInput || config.server || "";
  serverIds = serverIds.length ? serverIds : config.servers || [];

  const targets = config.targets || [];

  // Debug print out all the config
  core.debug(`config: ${JSON.stringify(config)}`);

  // Debug print out all the inputs after config
  core.debug(`source: ${sourcePath}`);
  core.debug(`sources: ${sourceListPath}`);
  core.debug(`target: ${targetPath}`);
  core.debug(`server-id: ${serverIdInput}`);
  core.debug(`server-ids: ${serverIds}`);

  if (
    !sourcePath &&
    !sourceListPath.length &&
    (!targets.length || targets.length == 0)
  )
    throw new Error(
      "Either source or sources must be defined. Both are empty."
    );
  if (!serverIdInput && !serverIds.length)
    throw new Error(
      "Either server-id or server-ids must be defined. Both are empty."
    );

  if (sourcePath && !sourceListPath.length) sourceListPath = [sourcePath];
  if (serverIdInput && !serverIds.length) serverIds = [serverIdInput];
  if (cleanupDryRun && (!deleteFilesInDir || !targetPath.endsWith("/"))) {
    throw new Error("cleanup-dry-run requires delete-files-in-dir: true and a target ending with '/'");
  }

  return {
    panelHost,
    apiKey,
    restart,
    command,
    proxy,
    sourceListPath,
    targetPath,
    serverIds,
    targets,
    decompressTarget,
    deleteFilesInDir,
    cleanupDryRun,
    filesType,
    filesList,
    deleteBatchSize,
    followSymbolicLinks,
  };
}

function configureAxios(panelHost, apiKey, proxy) {
  axios.defaults.baseURL = panelHost;
  axios.defaults.headers.common["Authorization"] = `Bearer ${apiKey}`;
  axios.defaults.maxContentLength = Infinity;
  axios.defaults.maxBodyLength = Infinity;

  if (proxy) {
    const [auth, hostPort] = proxy.split("@");
    const [username, password] = auth.split(":");
    const [host, port] = hostPort.split(":");

    const httpsAgent = tunnel.httpsOverHttp({
      proxy: {
        host: host,
        port: port,
        proxyAuth: `${username}:${password}`,
      },
    });

    let httpAgent = tunnel.httpOverHttp({
      proxy: {
        host: host,
        port: port,
        proxyAuth: `${username}:${password}`,
      },
    });

    axios.defaults.httpsAgent = httpsAgent;
    axios.defaults.httpAgent = httpAgent;
  }
}

function isArchiveFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return [".zip", ".tar", ".tar.gz", ".tgz", ".rar"].includes(ext);
}

async function uploadFile(serverId, targetFile, buffer) {
  const fileName = path.posix.basename(targetFile);
  const parent = path.posix.dirname(targetFile);
  const directory = normalizeServerPath(parent);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const signedResponse = await axios.get(
        `/api/client/servers/${serverId}/files/upload`
      );
      const signedUrl = signedResponse.data?.attributes?.url;
      if (!signedUrl) throw new Error("Panel did not return a signed upload URL");

      const form = new FormData();
      form.append("files", buffer, { filename: fileName });
      form.append("directory", directory);
      await axios.post(signedUrl, form, {
        params: { directory },
        headers: { ...form.getHeaders(), Authorization: undefined },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percentCompleted = Math.round(
              (progressEvent.loaded * 100) / progressEvent.total
            );
            core.info(
              `Uploading ${targetFile} to ${serverId} (${percentCompleted}%)`
            );
          }
        },
      });
      return;
    } catch (error) {
      lastError = error;
    }

    if (attempt < 3) {
      core.warning(`Upload attempt ${attempt} failed: ${lastError.message}. Retrying...`);
    }
  }

  const apiErrors = lastError?.response?.data?.errors;
  const details = Array.isArray(apiErrors)
    ? apiErrors.map((error) => error.detail).filter(Boolean).join("; ")
    : "";
  throw new Error(
    `Failed to upload ${targetFile} to server ${serverId} after 3 attempts: ` +
    (details || lastError.message)
  );
}

async function restartServer(serverId) {
  await axios.post(`/api/client/servers/${serverId}/power`, {
    signal: "restart",
  });
}

async function sendConsoleCommand(serverId, command) {
  await axios.post(`/api/client/servers/${serverId}/command`, {
    command: command,
  });
}

async function decompressFile(serverId, targetFile) {
  const apiRoot = path.posix.dirname(normalizeServerPath(targetFile));
  const fileName = path.posix.basename(targetFile);
  await axios.post(`/api/client/servers/${serverId}/files/decompress`, {
    root: apiRoot,
    file: fileName,
  });
}

async function deleteFile(serverId, targetFile) {
  // check if the response was 403 (forbidden), try again until the max retries is reached
  let retries = 0;
  let response;
  
  do {
    try {
      response = await axios.post(
        `/api/client/servers/${serverId}/files/delete`,
        {
          root: path.posix.dirname(normalizeServerPath(targetFile)),
          files: [path.posix.basename(targetFile)],
        }
      );
      
      if (response.status === 204) {
        core.info(`Successfully deleted ${targetFile}`);
        return;
      }
    } catch (error) {
      if (error.response?.status === 403 && retries < 2) {
        core.info(`Delete failed with 403, retrying... (attempt ${retries + 1})`);
        retries++;
        continue;
      }
      throw error;
    }
  } while (retries < 3);
}

function getInput(name, options = { required: false }) {
  return core.getInput(name, { ...options, trimWhitespace: true });
}

function getMultilineInput(name, options = { required: false }) {
  return core.getMultilineInput(name, { ...options, trimWhitespace: true });
}

async function readConfigFile() {
  const configFile = ".pterodactyl-upload.json";
  try {
    await fs.access(configFile);
    core.info(`Found ${configFile}, using it for configuration.`);
    const config = await fs.readFile(configFile, "utf8");
    return JSON.parse(config);
  } catch (error) {
    return {};
  }
}

main().then(() => {
  // All deployment requests are awaited in main(). An open HTTP socket must
  // not keep this one-shot action running after its result has been printed.
  process.stdout.write("", () => {
    process.stderr.write("", () => process.exit(process.exitCode ?? 0));
  });
});
