import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** 403 の応答本文に使う文言(ファイル内容や絶対パスは含めない)。 */
export const PROTECTED_PATH_ERROR =
  ".git・node_modules・隠しファイルは編集できません";

const isWindows = process.platform === "win32";

/**
 * root 相対パスの 1 セグメントが保護対象か。大小文字は無視し、Windows では
 * 末尾のドット・空白(OS が取り除く)と `:`(ADS 表記 `::$DATA` 等)も別名として扱う。
 */
function isProtectedSegment(segment: string): boolean {
  if (segment === "") return false;
  if (isWindows && segment.includes(":")) return true;
  const name = (isWindows ? segment.replace(/[. ]+$/, "") : segment).toLowerCase();
  if (name === "") return true;
  return name === "node_modules" || name.startsWith(".");
}

/** root 配下の相対パスに保護セグメントがあるか。root の外(..)は判定しない(範囲外判定は別途)。 */
function relHasProtectedSegment(rootPath: string, filePath: string): boolean {
  const rel = relative(rootPath, filePath);
  if (rel === "" || isOutsideRel(rel)) {
    return false;
  }
  return rel.split(/[\\/]+/).some(isProtectedSegment);
}

/**
 * パスの末端が本当に存在しないか(realpath が ENOENT、かつ lstat でも無い)。宙づり symlink は
 * lstat では存在するので false。
 */
function isMissing(path: string, err: unknown): boolean {
  if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
  try {
    lstatSync(path);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

/**
 * 実体パス。未存在なら最も近い既存の祖先を realpath して残りを連結する。
 * 祖先での補完は末端が本当に存在しない時だけ行い、それ以外の解決失敗(EACCES・EIO・ELOOP、
 * 宙づり symlink)は null を返す(呼び出し側は拒否する = fail-closed)。
 */
export function realpathOrNearest(abs: string): string | null {
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch (e) {
      if (!isMissing(cur, e)) return null;
      const parent = dirname(cur);
      if (parent === cur) return null;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** root からの相対パスが root の外(`..` 始まり・別ドライブ)か。隠しセグメントの判定とは別。 */
function isOutsideRel(rel: string): boolean {
  return isAbsolute(rel) || rel === ".." || /^\.\.[\\/]/.test(rel);
}

/**
 * file が root 配下(root 自身は除く)か。root と file を同じ方式(realpathSync.native)で
 * 実体に解決してから比べる。JS 実装の realpathSync は Windows の 8.3 短縮名を展開しないため、
 * 片方だけ native で解決すると `..\..\runneradmin\...` のように root 外と誤判定する。
 * 未存在のファイルは親ディレクトリが存在する時だけ認める。win32 の比較は path.relative が
 * 大小文字を無視する。
 */
export function isInsideRoot(root: string, file: string): boolean {
  let realRoot: string;
  let realFile: string;
  const abs = resolve(file);
  try {
    realRoot = realpathSync.native(root);
  } catch {
    return false;
  }
  try {
    realFile = realpathSync.native(abs);
  } catch (e) {
    // 補完は末端が本当に無い時だけ。EACCES・ELOOP・宙づり symlink などは root 外として拒否する。
    if (!isMissing(abs, e)) return false;
    try {
      realFile = join(realpathSync.native(dirname(abs)), basename(abs));
    } catch {
      return false;
    }
  }
  const rel = relative(realRoot, realFile);
  return rel !== "" && !isOutsideRel(rel);
}

/**
 * `.git`・`node_modules`・先頭ドットのセグメントを root 相対パスに含むか。
 * 字面(resolve 後)と realpath(symlink・8.3 名・大小文字の別名を解決)の両方で見る。
 * root より上のセグメントは見ない。
 */
export function isProtectedPath(root: string, file: string): boolean {
  const abs = resolve(file);
  if (relHasProtectedSegment(resolve(root), abs)) return true;
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    // root の実体を解決できなければ判定できないので保護扱い(fail-closed)
    return true;
  }
  const realFile = realpathOrNearest(abs);
  // 実体を解決できないものは保護対象として扱う(fail-closed)。
  if (realFile === null) return true;
  return relHasProtectedSegment(realRoot, realFile);
}
