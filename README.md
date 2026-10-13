# Pterodactyl Upload Action

![GitHub release (latest by date)](https://img.shields.io/github/v/release/Andromedov/pterodactyl-upload-action)
![GitHub](https://img.shields.io/github/license/Andromedov/pterodactyl-upload-action)

This GitHub Action allows you to upload files to multiple Pterodactyl servers with just one action, featuring socket support.

## Usage

## Api Key

You have to create a client api key in the pterodactyl panel. You can do this in the panel under `Account` -> `API Credentials`.

### Inputs

1. `panel-host`: (**Required**) The host URL of the Pterodactyl panel.
2. `api-key`: (**Required**) The API key for the Pterodactyl panel.
3. `server-id`: ID of the target server.
4. `server-ids`: IDs of the target servers (multiline).
5. `source`: Source file to be uploaded.
6. `sources`: Source files to be uploaded (multiline).
7. `target`: Destination of the file on the server. Can be a file name (for a single source) or a directory name ending with a slash (for multiple files).
8. `restart`: Restarts the server after successful upload.
9. `command`: Execute command at server after successful upload.
10. `proxy`: Proxy to be used for upload (username:password@host:port).
11. `decompress-target`: Decompress archive file after upload in target.
12. `delete-files-in-dir`: Apply the file filter in the target folder before upload.
13. `files-type`: `whitelist` keeps matches and deletes everything else; `blacklist` deletes matches.
14. `files-list`: Comma-separated file or directory patterns, relative to `target`.
15. `follow-symbolic-links`: Follow local source symlinks during globbing. Remote cleanup never traverses symlinks.
16. `delete-batch-size`: Maximum entries per cleanup DELETE request. Default `0` preserves one request per directory; a positive integer enables sequential bounded batches.
17. `cleanup-dry-run`: Default `false`. Print the cleanup plan using listing requests only and stop before deletion or deployment. Requires `delete-files-in-dir: true` and a directory target ending with `/`.

Before any server requests, preflight resolves every source pattern, including `config.targets`, requires at least one match per pattern and reads each regular source file. Missing files, empty globs, read errors and invalid targets stop the action before cleanup. Sources or destinations ending in `.zip` also undergo structure, decompressed-size and CRC-32 checks without extracting files. ZIP entries must use supported, unencrypted compression; other archive formats receive only file/readability checks.

Upload uses the exact checked bytes even if a local file changes afterward. Buffers are retained until the action exits and shared when the same source is reused across targets or servers. Memory usage includes the total size of distinct source files.

To review cleanup while validating the deployment sources:

```yaml
delete-files-in-dir: true
cleanup-dry-run: true
files-type: whitelist
files-list: config/, data/, logs/
```

Dry-run applies the same whitelist checks and directory traversal as normal cleanup. It prints planned batches and all selected names in bounded log lines for every configured server. It sends only GET listing requests and finishes with `Cleanup dry-run complete; no deployment performed`. Upload, decompression, deletion, console commands and restart are skipped. To execute the reviewed deployment, set `cleanup-dry-run: false` on a subsequent run.

The action uses Node.js 24, as required by current [GitHub Actions runtimes](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/). Self-hosted runners must support Node 24. Build and test locally with Node 24 using `npm ci`, `npm run build` and `npm test`.

Quote patterns starting with `*` in YAML, such as `files-list: '*/data/'`.

```yaml
delete-files-in-dir: true
files-type: whitelist
files-list: data/settings.yml,data/players/
```

### Example Workflow Configuration

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    name: Deploy to Pterodactyl
    steps:
      - name: Checkout
        uses: actions/checkout@v4.2.2
      - run: echo "Hello world" > hello.txt
      - uses: Andromedov/pterodactyl-upload-action@v2.5.5
        with:
          panel-host: ${{ secrets.PANEL_HOST }}
          api-key: ${{ secrets.API_KEY }}
          server-id: "5f095019"
          #   server-ids: |
          #     5f095019
          #     7f095019
          source: "hello.txt"
          #   sources: |
          #     hello.txt
          #     hello2.txt
          target: "./"
          # If you want to restart the servers after successful upload
          # restart: true
          # If you want to decompress the files after successful upload
          # decompress-target: true
          # If you want to remove all files from target folder before upload
          # delete-files-in-dir: true
```

## File Decompression

`decompress-target` allows decompression of archive files (`.zip, .tar, .tar.gz, .tgz, .rar`) after they are uploaded to the server. If you have multiple targets, it will decompress all valid compressed ones. If this option is not provided or set to false, files will be uploaded as is, without decompression.

The archive will be deleted after decompression.

### Multiple File/Server Example

Uncomment lines for `server-ids`, `sources`, and `proxy` in the above example as necessary.

## Configuration File

An optional `.pterodactyl-upload.json` file can be created in the root of your repository to define server(s), source file(s), and the target.

### Example Configuration File

```json
{
  "server": "5f095019",
  "servers": ["5f095019", "7f095019"],
  "source": "hello.txt",
  "sources": ["hello.txt", "hello2.txt"],
  "target": "./"
}
```

#### Multiple different targets

If you need different targets for each file, you can provide a list of targets.

```json
{
  "targets": {
    "source": "hello.txt",
    "target": "./"
  }
}
```

## License

Pterodactyl Upload Action is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.
