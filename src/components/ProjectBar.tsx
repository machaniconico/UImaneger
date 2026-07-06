import { useState } from "react";
import type { ProjectInfo } from "../lib/types.ts";
import { api } from "../lib/api.ts";

interface Props {
  info: ProjectInfo | null;
  hasKey: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onInfo: (i: ProjectInfo | null) => void;
  onError: (m: string) => void;
  selectMode: boolean;
  setSelectMode: (b: boolean) => void;
}

export function ProjectBar({
  info,
  hasKey,
  busy,
  setBusy,
  onInfo,
  onError,
  selectMode,
  setSelectMode,
}: Props) {
  const [value, setValue] = useState("");

  const isRepo = /^(https?:\/\/|git@)/.test(value.trim());

  async function reconcileInfo() {
    try {
      const s = await api.status();
      onInfo(s.info);
    } catch {
      // 元のエラー表示を優先するため、再同期失敗は握りつぶす
    }
  }

  async function openOrClone() {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    onError("");
    try {
      const res = isRepo ? await api.clone(v) : await api.open(v);
      if (res.error) {
        onError(res.error);
        await reconcileInfo();
      } else {
        onInfo(res.info ?? null);
      }
    } catch (e: any) {
      onError(String(e.message || e));
      await reconcileInfo();
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    onError("");
    try {
      const res = await api.stop();
      onInfo(res.info);
    } catch (e: any) {
      onError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-3 text-sm text-neutral-200">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-blue-400">UImaneger</span>
        <span className="text-xs">
          {hasKey ? (
            <span className="text-green-400">● API key OK</span>
          ) : (
            <span className="text-red-400">● key 未設定</span>
          )}
        </span>
      </div>

      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && openOrClone()}
        aria-label="ローカルパスまたはGitHub URL"
        placeholder="ローカルパス または GitHub URL"
        className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 outline-none focus:border-blue-500"
      />
      <button
        onClick={openOrClone}
        disabled={busy}
        className="w-full rounded bg-blue-600 px-3 py-1 font-medium hover:bg-blue-500 disabled:opacity-50"
      >
        {busy ? "起動中…" : isRepo ? "Clone & 起動" : "開く"}
      </button>

      {info?.running && (
        <>
          <div className="flex gap-2">
            <button
              onClick={() => setSelectMode(!selectMode)}
              aria-pressed={selectMode}
              className={`flex-1 rounded px-3 py-1 font-medium ${
                selectMode
                  ? "bg-amber-500 text-black"
                  : "bg-neutral-700 hover:bg-neutral-600"
              }`}
            >
              {selectMode ? "選択中…" : "要素を選択"}
            </button>
            <button
              onClick={stop}
              className="rounded bg-neutral-700 px-3 py-1 hover:bg-neutral-600"
            >
              停止
            </button>
          </div>
          <span className="truncate text-xs text-neutral-400">
            {info.name} · {info.framework}
          </span>
        </>
      )}
    </div>
  );
}
