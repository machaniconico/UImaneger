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
    if (busy) return;
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
    <div className="flex flex-col gap-2.5 border-b border-neutral-800 bg-surface px-3 py-3 text-sm text-neutral-200">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="grid h-4 w-4 grid-cols-2 gap-0.5">
            <span className="rounded-[2px] bg-accent-400" />
            <span className="rounded-[2px] bg-accent-600" />
            <span className="rounded-[2px] bg-accent-600" />
            <span className="rounded-[2px] bg-accent-400" />
          </div>
          <span className="font-semibold tracking-tight text-neutral-100">UImaneger</span>
        </div>
        <span className="text-[10px] font-medium">
          {hasKey ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-green-400 ring-1 ring-inset ring-green-500/20">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" /> API key OK
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-red-400 ring-1 ring-inset ring-red-500/20">
              <span className="h-1.5 w-1.5 rounded-full bg-red-400" /> key 未設定
            </span>
          )}
        </span>
      </div>

      <div className="flex overflow-hidden rounded-lg border border-neutral-700 bg-raised focus-within:border-accent-500 focus-within:ring-1 focus-within:ring-accent-500/40">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") openOrClone();
          }}
          aria-label="ローカルパスまたはGitHub URL"
          placeholder="ローカルパス または GitHub URL"
          className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-500"
        />
        <button
          onClick={openOrClone}
          disabled={busy}
          className="shrink-0 border-l border-neutral-700 bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-50"
        >
          {busy ? "起動中…" : isRepo ? "Clone & 起動" : "開く"}
        </button>
      </div>

      {info?.running && (
        <>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectMode(!selectMode)}
              aria-pressed={selectMode}
              disabled={busy}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium ${
                selectMode
                  ? "animate-pulse bg-accent-600 text-white shadow-sm shadow-accent-500/30 motion-reduce:animate-none"
                  : "bg-raised text-neutral-300 hover:bg-neutral-700 hover:text-white"
              }`}
            >
              {selectMode ? "選択中…" : "要素を選択"}
            </button>
            <button
              onClick={stop}
              disabled={busy}
              className="rounded-md border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-400 hover:border-neutral-600 hover:bg-raised hover:text-neutral-200"
            >
              停止
            </button>
          </div>
          <span className="truncate px-0.5 text-[10px] text-neutral-500">
            {info.name} · {info.framework}
          </span>
        </>
      )}
    </div>
  );
}
