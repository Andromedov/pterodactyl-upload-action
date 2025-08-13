const core = require("@actions/core");
const axios = require("axios").default;
const fs = require("fs").promises;
const path = require("path");
const glob = require("@actions/glob");
const tunnel = require("tunnel");
const { AxiosError } = require("axios");

axios.defaults.headers.common.Accept = "application/json";

async function main() {
  try {
    const settings = await getSettings();
    configureAxios(settings.panelHost, settings.apiKey, settings.proxy);

    const {
      serverIds,
      sourceListPath,
      targetPath,
      restart,
      command,
      targets,
      decompressTarget,
    } = settings;

    let fileSourcePaths = [];
    for (const source of sourceListPath) {
      const globber = await glob.create(source, {
        followSymbolicLinks: settings.followSymbolicLinks,
      });
      const files = await globber.glob();
      fileSourcePaths = [...fileSourcePaths, ...files];
    }

    for (const serverId of serverIds) {
      core.debug(`Uploading to server ${serverId}`);
      if (settings.deleteFilesInDir && targetPath.endsWith("/")) {
        await deleteFilesInDirectory(serverId, targetPath, settings.filesType, settings.filesList);
      }
      for (const source of fileSourcePaths) {
        core.debug(`Processing source ${source}`);
        await validateSourceFile(source);
        const targetFile = getTargetFile(targetPath, source);
        const buffer = await fs.readFile(source);

        await uploadFile(serverId, targetFile, buffer);

        if (decompressTarget && isArchiveFile(targetFile)) {
          await decompressFile(serverId, targetFile);
          await deleteFile(serverId, targetFile);
        }
      }

      for (const element of targets) {
        core.debug(`Processing target ${JSON.stringify(element)}`);
        const { source, target } = element;
        const globber = await glob.create(source, {
          followSymbolicLinks: settings.followSymbolicLinks,
        });
        const paths = await globber.glob();
        for (const source of paths) {
          await validateSourceFile(source);
          const targetFile = getTargetFile(target, source);
          const buffer = await fs.readFile(source);

          await uploadFile(serverId, targetFile, buffer);

          if (decompressTarget && isArchiveFile(targetFile)) {
            await decompressFile(serverId, targetFile);
            await deleteFile(serverId, targetFile);
          }
        }
      }

      if (command != "") await sendConsoleCommand(serverId, command);
      if (restart) await restartServer(serverId);
    }

    core.info("Done");
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function getSettings() {
  const panelHost = getInput("panel-host", { required: true });
  const apiKey = getInput("api-key", { required: true });
  const restart = getInput("restart") == "true";
  const command = getInput("command");
  const proxy = getInput("proxy");
  const decompressTarget = getInput("decompress-target") == "true";
  const deleteFilesInDir = getInput("delete-files-in-dir") == "true";
  const followSymbolicLinks = getInput("follow-symbolic-links") == "true";
  const filesType = getInput("files-type") || "blacklist";
  const filesListInput = getInput("files-list") || "";

  // Parse files list - handle both multiline and comma-separated input
  let filesList = [];
  if (filesListInput) {
    if (filesListInput.includes('\n')) {
      // Multiline input
      filesList = filesListInput
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    } else {
      // Comma-separated input
      filesList = filesListInput
        .split(',')
        .map(file => file.trim())
        .filter(file => file.length > 0);
    }
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
  core.debug(`files-type: ${filesType}`);
  core.debug(`files-list: ${JSON.stringify(filesList)}`);

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

  // Validate files-type input
  if (filesType !== "whitelist" && filesType !== "blacklist") {
    throw new Error("files-type must be either 'whitelist' or 'blacklist'");
  }

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
    followSymbolicLinks,
    filesType,
    filesList,
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

async function validateSourceFile(source) {
  try {
    const stats = await fs.lstat(source);
    if (stats.isDirectory())
      throw new Error("Source must be a file, not a directory");
  } catch (error) {
    throw new Error(`Source file ${source} does not exist.`);
  }
}

function isArchiveFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return [".zip", ".tar", ".tar.gz", ".tgz", ".rar"].includes(ext);
}

function getTargetFile(targetPath, source) {
  return targetPath.endsWith("/")
    ? path.join(targetPath, path.basename(source))
    : targetPath;
}

async function uploadFile(serverId, targetFile, buffer) {
  // check if the response was 403 (forbidden), try again until the max retries is reached
  let retries = 0;
  let uploaded = false;
  while (!uploaded && retries < 3) {
    try {
      let response = await axios.post(
        `/api/client/servers/${serverId}/files/write`,
        buffer,
        {
          params: { file: targetFile },
          onUploadProgress: (progressEvent) => {
            const percentCompleted = Math.round(
              (progressEvent.loaded * 100) / progressEvent.total
            );
            core.info(
              `Uploading ${targetFile} to ${serverId} (${percentCompleted}%)`
            );
          },
        }
      );
      if (response?.status == 204) {
        uploaded = true;
      } else {
        core.error(
          `Upload failed with status ${response?.status}, retrying...`
        );
      }
    } catch (error) {
      core.error(`Upload failed with error ${error}, retrying...`);
      core.debug(`Error response: ${JSON.stringify(error?.response?.data)}`);
    }
    retries++;
  }
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
  const rootDir = path.dirname(targetFile);
  const fileName = path.basename(targetFile);
  const apiRoot = rootDir === '.' ? '/' : rootDir;
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
          root: "/",
          files: [targetFile],
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

/**
 * Check if file matches pattern (supports glob patterns)
 */
function isFileMatch(fileName, pattern) {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    // Exact match
    return fileName === pattern;
  }
  
  // Simple glob pattern matching
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  
  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(fileName);
}

/**
 * Filters files to get list of files that should be DELETED based on whitelist/blacklist mode
 * @param {Array} files - Array of file names
 * @param {string} filesType - "whitelist" or "blacklist"
 * @param {Array} filesList - Array of file names to include/exclude
 * @returns {Array} - Array of file names that should be DELETED
 */
function filterFiles(files, filesType, filesList) {
  if (!filesList || filesList.length === 0) {
    // If no files specified, return all files for blacklist mode or empty for whitelist
    return filesType === "blacklist" ? files : [];
  }

  if (filesType === "whitelist") {
    // WHITELIST: Delete all files EXCEPT those that match the patterns (keep whitelist files)
    return files.filter(fileName =>
      !filesList.some(pattern => isFileMatch(fileName, pattern))
    );
  } else {
    // BLACKLIST: Delete only files that match the patterns (delete blacklist files)
    return files.filter(fileName =>
      filesList.some(pattern => isFileMatch(fileName, pattern))
    );
  }
}

async function deleteFilesInDirectory(serverId, targetPath, filesType = "blacklist", filesList = []) {
  core.info(`Deleting files in ${targetPath} on server ${serverId} (mode: ${filesType})`);
  
  if (filesList && filesList.length > 0) {
    core.info(`File filter list: ${JSON.stringify(filesList)}`);
  }
  
  try {
    // Get list of files in directory
    const response = await axios.get(`/api/client/servers/${serverId}/files/list`, {
      params: { directory: targetPath },
    });
    
    const files = response.data.data || response.data;
    const allFileNames = files
      .filter(item => item.attributes ? !item.attributes.is_directory : !item.is_directory)
      .map(item => {
        const name = item.attributes ? item.attributes.name : item.name;
        return name;
      });
    
    if (allFileNames.length === 0) {
      core.info(`No files found in ${targetPath}`);
      return;
    }
    
    core.info(`Found ${allFileNames.length} files in directory: ${allFileNames.join(', ')}`);
    
    // Filter files based on whitelist/blacklist mode
    const filesToDelete = filterFiles(allFileNames, filesType, filesList);
    
    if (filesToDelete.length === 0) {
      core.info(`No files to delete after applying ${filesType} filter`);
      return;
    }
    
    core.info(`Files to delete (${filesType} mode): ${filesToDelete.join(', ')}`);
    
    if (filesType === "whitelist" && filesList.length > 0) {
      const filesToKeep = allFileNames.filter(fileName =>
        filesList.some(pattern => isFileMatch(fileName, pattern))
      );
      core.info(`Files to keep (whitelist): ${filesToKeep.join(', ')}`);
    }
    
    // Delete the filtered files
    await axios.post(`/api/client/servers/${serverId}/files/delete`, {
      root: targetPath,
      files: filesToDelete,
    });
    
    core.info(`Successfully deleted ${filesToDelete.length} files from ${targetPath}`);
  } catch (error) {
    core.error(`Failed to delete files in directory: ${error.message}`);
    if (error.response) {
      core.debug(`API Error: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

// Keep the old function name for backward compatibility
async function deleteAllFilesInDirectory(serverId, targetPath) {
  return deleteFilesInDirectory(serverId, targetPath, "blacklist", []);
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

main();