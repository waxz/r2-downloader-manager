# ☁️ Cloudflare R2 Stream Downloader & Manager

A high-performance, serverless download manager built on **Cloudflare Workers**, **Durable Objects**, and **R2 Storage**.

This tool allows you to fetch large files from remote URLs and stream them directly into your R2 bucket. It uses zero-copy streaming to keep memory usage extremely low (works within 128MB limits) and optimizes R2 costs by using a single Write operation per file.

## ✨ Features

*   **🚀 Streaming Uploads:** Pipes remote `fetch` bodies directly to R2 using `TransformStream`. Never holds the full file in memory.
*   **💰 Cost Optimized:** Uses `FixedLengthStream` to ensure R2 counts the upload as **1 Class A Operation** (instead of hundreds of multipart chunks).
*   **🔄 Background Processing:** Uses **Durable Objects** to keep downloads running reliably in the background, even if the client disconnects.
*   **💾 Smart Caching:** Checks if a file already exists in R2 before starting a download to save bandwidth and operations.
*   **🖥️ Admin Dashboard:** Built-in HTML/JS Single Page Application (SPA) to manage downloads, view history, and delete files.
*   **📤 Direct Uploads:** Supports direct binary uploads from your computer to R2 via the dashboard.
*   **🔒 Authentication:** Simple API Key protection for all routes.

## 🛠️ Prerequisites

*   A Cloudflare Account.
*   `wrangler` CLI installed (`npm install -g wrangler`).

## ⚙️ Configuration (`wrangler.toml`)

Create a `wrangler.toml` file in your project root.


```toml
name = "r2-downloader"
main = "src/_worker.js"
compatibility_date = "2026-01-01"

# R2 bucket binding
[[r2_buckets]]
binding = "WEBDAV_STORAGE"
bucket_name = "my-drive-bucket"
preview_bucket_name = "my-drive-bucket-preview"  # Optional: separate bucket for dev

# Durable Objects configuration
[durable_objects]
bindings = [
  { name = "DOWNLOAD_MANAGER", class_name = "DownloadManager" }
]

# Durable Objects migration
[[migrations]]
tag = "<v1>"
new_sqlite_classes = ["DownloadManager"]

# Optional: Environment variables
[vars]
# Add any environment variables here
```

### Reference:
- https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/


## 🧪 Local Development

1. **Create `.dev.vars`**
  ```
  APIKEYSECRET=yourapi
  WEBDAV_USERNAME=yourusername
  WEBDAV_PASSWORD=yourpassword
  ```
  `WEBDAV_USERNAME`/`WEBDAV_PASSWORD` are required for WebDAV access — there
  is no default credential. If either is missing, all WebDAV requests are
  rejected (fail closed), so WebDAV clients (Finder, Explorer, rclone, etc.)
  won't be able to connect until both are set.
2. **Start Server**
  ```bash
  npx wrangler dev -c ./wrangler.workers.toml
  ```


## 🚀 Deployment

1.  **Create the R2 Bucket:**
    ```bash
    npx wrangler r2 bucket create my-drive-bucket
    ```

2.  **Set the API Key (Required):**

    Without this, the file manager API (`/api/*`: uploads, downloads,
    listing, jobs, shares, admin settings) rejects every request — there is
    no "open" fallback mode.

    - Workers
    ```bash
    npx wrangler secret put APIKEYSECRET  -c ./wrangler.workers.toml
    # Enter your desired password when prompted
    ```
    - Pages
    ```bash
    npx wrangler pages secret put APIKEYSECRET
    ```

2b. **Set the WebDAV credentials (Required for WebDAV access):**

    There is no default WebDAV username/password. If these aren't set,
    every WebDAV request is rejected — WebDAV is simply unusable, not
    protected by a fallback credential.

    - Workers
    ```bash
    npx wrangler secret put WEBDAV_USERNAME -c ./wrangler.workers.toml
    npx wrangler secret put WEBDAV_PASSWORD -c ./wrangler.workers.toml
    ```
    - Pages
    ```bash
    npx wrangler pages secret put WEBDAV_USERNAME
    npx wrangler pages secret put WEBDAV_PASSWORD
    ```

3.  **Deploy:**
    - Workers
    
    ```bash
    npx wrangler deploy -c ./wrangler.workers.toml
    ```
    - Pages

    ```bash
    npx wrangler pages deploy 
    ```

## 🖥️ Usage

### Admin Panel
Visit your worker URL in a browser:
`https://r2-stream-downloader.your-subdomain.workers.dev/?key=YOUR_SECRET_KEY`

*   **Remote Downloader:** Paste a URL to download it to R2.
*   **Direct Upload:** Select a file from your computer to stream to R2.
*   **Library:** View, download, or delete files currently in your bucket.

## 🧠 How it Works

1.  **The Pipeline:**
    `Remote URL` -> `fetch()` -> `TransformStream (Counting)` -> `FixedLengthStream` -> `R2 put()`
2.  **Memory Safety:**
    By using streams, the Worker never loads the file into RAM. It only holds a tiny chunk (approx 64KB) at any given millisecond.
3.  **Durable Object Life:**
    We use `state.waitUntil()` inside the Durable Object. This tells Cloudflare "Don't freeze this instance, I'm doing work," allowing the download to continue even after the HTTP response is sent to the user.

## 📝 License

MIT License. Feel free to modify and use for your own projects.

## 📚 API Reference

### Authentication
All requests require `x-api-key` header or `?key=` query parameter.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/jobs/init` | Start remote download |
| POST | `/api/jobs/chunk` | Download chunk (internal) |
| POST | `/api/jobs/status` | Check download status |
| POST | `/api/jobs/finish` | Complete multipart download |
| POST | `/api/jobs/abort` | Cancel download |
| GET | `/api/files` | List files |
| GET | `/api/files/info?key=...` | Get file info |
| POST | `/api/files/delete` | Delete files |
| POST | `/api/files/rename` | Rename file |
| POST | `/api/files/move` | Move file |
| POST | `/api/files/copy` | Copy file |
| POST | `/api/files/mkdir` | Create folder |
| PUT | `/api/upload?filename=...` | Upload file |
| GET | `/get/:filename` | Download file |
| POST | `/api/shares/create` | Create share link |
| GET | `/api/shares` | List shares |
| POST | `/api/shares/revoke` | Revoke share |

### MCP (Model Context Protocol)

`POST /mcp` exposes the same file storage as MCP tools, so an MCP client
(an AI agent, Claude Desktop, etc.) can list, read, write, delete, move and
copy files in the bucket. It speaks JSON-RPC 2.0 over plain HTTP (the
Streamable HTTP transport's non-streaming mode — one request in, one
response out) and uses the same `x-api-key`/`?key=` auth as the REST API
above. Available tools: `list_directory`, `list_all_folders`, `read_file`,
`write_file`, `create_directory`, `delete_file`, `delete_directory`,
`move_file`, `copy_file`, `get_file_info`.

```bash
# List the tools available
curl -X POST "https://your-domain.com/mcp" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call a tool
curl -X POST "https://your-domain.com/mcp" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_directory","arguments":{"path":"/"}}}'
```

## 💻 Command Line Examples

### Upload File (Correct Usage)
```bash
# Upload with explicit Content-Type
curl -X PUT "https://your-domain.com/api/upload?filename=folder/image.png" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: image/png" \
  --data-binary @image.png

# Upload (auto-detect content type)
curl -X PUT "https://your-domain.com/api/upload?filename=folder/file.zip" \
  -H "x-api-key: YOUR_API_KEY" \
  --data-binary @file.zip

# Upload to root
curl -X PUT "https://your-domain.com/api/upload?filename=myfile.mp4" \
  -H "x-api-key: YOUR_API_KEY" \
  --data-binary @myfile.mp4
```

### Start Remote Download
```bash
curl -X POST "https://your-domain.com/api/jobs/init" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sourceUrl":"https://example.com/video.mp4","filename":"/downloads/video.mp4"}'
```

### List Files
```bash
curl "https://your-domain.com/api/files" -H "x-api-key: YOUR_API_KEY"
```

### Delete Files
```bash
curl -X POST "https://your-domain.com/api/files/delete" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"keys":["/folder/file.png"]}'
```

### Create Share Link
```bash
curl -X POST "https://your-domain.com/api/shares/create" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename":"/video.mp4","hours":24}'
```

## ⚠️ Common Errors & Troubleshooting

### 1. File Upload Corrupted / Wrong Size
**Symptom:** Uploaded file size doesn't match original.

**Cause:** Using `-d` instead of `--data-binary` in curl.

**Solution:**
```bash
# Wrong - treats @ as literal string
curl -X PUT "url" -d @file.zip

# Correct - reads file as binary
curl -X PUT "url" --data-binary @file.zip
```

### 2. Double Slash in URL
**Symptom:** `https://domain.com//folder/file.mp4`

**Cause:** Filename started with `/` in both query param and path.

**Solution:** The API now handles this automatically. If using share links, make sure the filename doesn't have leading slashes.

### 3. Unknown Content-Length Error
**Symptom:** `Cannot download: source does not support Range requests and Content-Length is unknown`

**Cause:** Remote server doesn't provide file size (live streams, chunked encoding).

**Solution:** Use a source with known file size, or download directly to R2 using a different method.

### 4. File Not Found
**Symptom:** `Not found` when trying to get/download file.

**Causes:**
- File was uploaded to wrong path (check leading `/`)
- File was deleted
- API key mismatch

**Solution:** Check file list with `/api/files` endpoint to verify actual file paths.

### 5. CORS Errors in Browser
**Symptom:** Console shows CORS errors when using dashboard.

**Solution:** Ensure you're accessing the correct worker URL and API key is set in the dashboard.

### 6. Durable Object Errors
**Symptom:** Download fails or hangs.

**Solution:** 
- Check wrangler.workers.toml has correct Durable Object bindings
- Ensure migrations are applied: `npx wrangler deploy --force`
- Check Durable Objects are properly configured in wrangler.toml

## 🔧 Path Conventions

- All file paths should start with `/` (e.g., `/folder/file.png`)
- Folder paths should end with `/` (e.g., `/photos/`)
- The API normalizes paths automatically, but for consistency:
  - Upload: `/folder/filename.ext`
  - Folder: `/folder/`
  - Root: `/filename.ext`


# Webdav

https://github.com/xu-2hua/CloudFlare-WebDav.git


# localflare
https://github.com/rohanprasadofficial/localflare
```bash
npx localflare
```