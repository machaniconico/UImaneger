import http from "node:http";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function parsePort(argv) {
  const index = argv.indexOf("--port");
  const value = index >= 0 ? argv[index + 1] : process.env.PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  return port;
}

const root = realpathSync(process.cwd());
const port = parsePort(process.argv.slice(2));

function isInsideRoot(path) {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function sendText(res, status, message) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(message)),
    "cache-control": "no-store",
  });
  res.end(message);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD");
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  } catch {
    sendText(res, 400, "Bad Request");
    return;
  }
  const segments = pathname.split("/").filter(Boolean);
  if (
    pathname.includes("\0") ||
    segments.some(
      (segment) =>
        (segment.startsWith(".") && segment !== ".well-known") ||
        segment.toLowerCase() === "node_modules"
    )
  ) {
    sendText(res, 404, "Not Found");
    return;
  }

  let file = resolve(root, `.${pathname.replace(/\\/g, "/")}`);
  if (!isInsideRoot(file)) {
    sendText(res, 404, "Not Found");
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    file = realpathSync(file);
    if (!isInsideRoot(file) || !statSync(file).isFile()) throw new Error("not a file");
  } catch {
    sendText(res, 404, "Not Found");
    return;
  }

  const size = statSync(file).size;
  res.writeHead(200, {
    "content-type": MIME.get(extname(file).toLowerCase()) || "application/octet-stream",
    "content-length": String(size),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Static server listening on http://127.0.0.1:${port}`);
});
