const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
};

const RANGE_EXTENSIONS = new Set([".mp3", ".mp4", ".wav"]);
const COMPRESSIBLE_EXTENSIONS = new Set([".html", ".css", ".js", ".json", ".svg"]);
const NO_CACHE_EXTENSIONS = new Set([".html", ".json"]);

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

// Directory requests fall back to index.html, matching GitHub Pages. Any site can
// be served as a root, so the same handler covers the portfolio and Framepick.
function createStaticHandler({ root }) {
  const siteRoot = path.resolve(root);

  function resolveFile(urlPath) {
    const clean = safeDecode(urlPath.split("?")[0].split("#")[0]);
    const relative = clean.endsWith("/") ? `${clean}index.html` : clean;
    const full = path.join(siteRoot, relative);
    if (path.resolve(full) !== siteRoot && !path.resolve(full).startsWith(siteRoot + path.sep)) return null;
    return full;
  }

  return function handleStatic(req, res, requestUrl) {
    const file = resolveFile(requestUrl.pathname || "/");
    if (!file) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const ext = path.extname(file).toLowerCase();
      const type = types[ext] || "application/octet-stream";
      const cacheControl = NO_CACHE_EXTENSIONS.has(ext)
        ? "no-cache"
        : "public, max-age=31536000, immutable";
      const headers = {
        "Content-Type": type,
        "Cache-Control": cacheControl,
      };
      const range = req.headers.range;
      const supportsRange = RANGE_EXTENSIONS.has(ext);

      if (supportsRange) headers["Accept-Ranges"] = "bytes";

      if (supportsRange && range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!match) {
          res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
          res.end();
          return;
        }

        const start = match[1] === "" ? 0 : Number(match[1]);
        const end = match[2] === "" ? stat.size - 1 : Number(match[2]);

        if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || end >= stat.size) {
          res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
          res.end();
          return;
        }

        res.writeHead(206, {
          ...headers,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        });

        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }

      const acceptEncoding = String(req.headers["accept-encoding"] || "");
      const compression = COMPRESSIBLE_EXTENSIONS.has(ext) && acceptEncoding.includes("br")
        ? "br"
        : COMPRESSIBLE_EXTENSIONS.has(ext) && acceptEncoding.includes("gzip")
          ? "gzip"
          : "";

      if (!compression) {
        res.writeHead(200, {
          ...headers,
          "Content-Length": stat.size,
        });
        fs.createReadStream(file).pipe(res);
        return;
      }

      res.writeHead(200, {
        ...headers,
        "Content-Encoding": compression,
        "Vary": "Accept-Encoding",
      });
      const compressor = compression === "br"
        ? zlib.createBrotliCompress()
        : zlib.createGzip();
      fs.createReadStream(file).pipe(compressor).pipe(res);
    });
  };
}

module.exports = { createStaticHandler };
