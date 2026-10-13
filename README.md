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

All file inputs support glob patterns.

Uploads use a signed URL from the panel to send files directly to the server's Agent. The GitHub Actions runner must be able to reach the Agent URL configured in the panel. If `delete-files-in-dir` is enabled, matching files are removed before the upload starts; keep it disabled while testing a new deployment.

File patterns are checked inside nested directories. A name such as `cache.yml` matches at any depth. A path such as `data/settings.yml` matches relative to `target`. Both `*/data/` and `**/data/` match every directory named `data`, including ones several levels below `target`. In whitelist mode, `data/` keeps every directory with that name and its contents, while `data/settings.yml` keeps only that file and its parent directories. In blacklist mode, a matching directory and all its contents are deleted. For example:

An empty whitelist stops cleanup. When a nonempty whitelist matches nothing in a nonempty target, the action stops before deleting any files. A missing individual whitelist entry (for example `logs/`) is allowed if another entry matches. Protected directories and all their contents are kept without listing those contents.

Directory whitelist patterns also preserve matching symlinks. If a path pattern could protect descendants beneath a symlink, cleanup stops because it cannot inspect that subtree safely. A blacklist directory pattern does not treat a symlink as a directory; a file/name pattern can select the link itself. Patterns include dotfiles, and leading `!` or `#` are literal name characters. Commas inside brace glob groups such as `{a/b,c/d}/keep.yml` do not split the pattern list.

Server paths with `./`, without `./`, or starting with `/` address the same server-relative location and are normalized to POSIX paths. In the workflow, directory targets still require a trailing `/`; a target without it denotes a destination file. Parent traversal (`..`) is rejected.

Cleanup completes its full read-only listing and validation before deleting anything. Listing errors and malformed API responses stop before deletion; a failed DELETE stops the action before upload and is never retried. A failed DELETE can have partially removed its batch on the server. Logs identify the operation, method, endpoint, directory, batch count, bounded names, status and relevant API details, without dumping headers or signed URLs.

If diagnostics confirm DELETE failures related to batch size, `delete-batch-size: 5` can limit each request to five entries. This is opt-in, not a guarantee that large directory trees or inaccessible paths can be deleted. After a failure, inspect server logs and remaining files before another deployment. See [the investigation](CLEANUP_INVESTIGATION.md) for the version comparison and verification steps.

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
