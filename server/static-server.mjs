import http from "node:http";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

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

const root = realpathSync.native(process.cwd());
const port = parsePort(process.argv.slice(2));

function isInsideRoot(path) {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

const isWindows = process.platform === "win32";

/** 隠し名(.well-known を除く)・node_modules・Windows の別名表記(ADS・末尾ドット/空白)を拒否する。 */
function isBlockedSegment(segment) {
  if (segment === "") return false;
  if (isWindows && segment.includes(":")) return true;
  const name = (isWindows ? segment.replace(/[. ]+$/, "") : segment).toLowerCase();
  if (name === "") return true;
  if (name === "node_modules") return true;
  return name.startsWith(".") && name !== ".well-known";
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

  // request-target をそのまま 1 回だけデコードする(URL で正規化すると `//.env` が
  // ホスト扱いになる等、検査と実際のパスがずれるため使わない)。
  const target = (req.url || "/").split(/[?#]/, 1)[0];
  let pathname;
  try {
    pathname = decodeURIComponent(target);
  } catch {
    sendText(res, 400, "Bad Request");
    return;
  }
  // `\` は Windows で区切りとして解釈されうるので、検査をすり抜けないよう拒否する。
  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0")) {
    sendText(res, 404, "Not Found");
    return;
  }
  pathname = posix.normalize(pathname);
  if (pathname.split("/").some(isBlockedSegment)) {
    sendText(res, 404, "Not Found");
    return;
  }

  let file = resolve(root, `.${pathname}`);
  if (!isInsideRoot(file)) {
    sendText(res, 404, "Not Found");
    return;
  }
  let fd;
  let size;
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    // symlink や 8.3 名・大小文字の別名を実体名に解決してから同じ検査をやり直す。
    file = realpathSync.native(file);
    if (!isInsideRoot(file) || relative(root, file).split(sep).some(isBlockedSegment)) {
      throw new Error("blocked");
    }
    const checked = statSync(file);
    if (!checked.isFile()) throw new Error("not a file");
    // 検査した実体そのものを開いて配信する(検査後に差し替えられたら配信しない)。
    // FIFO への差し替えで、fstat に到達する前の open がブロックしないようにする。
    fd = openSync(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino) {
      throw new Error("changed after check");
    }
    size = opened.size;
  } catch {
    if (fd !== undefined) closeSync(fd);
    sendText(res, 404, "Not Found");
    return;
  }

  res.writeHead(200, {
    "content-type": MIME.get(extname(file).toLowerCase()) || "application/octet-stream",
    "content-length": String(size),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD" || size === 0) {
    closeSync(fd);
    res.end();
    return;
  }
  const stream = createReadStream(null, { fd, start: 0, end: size - 1 });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Static server listening on http://127.0.0.1:${port}`);
});
