import { useEffect, useState } from "react";
import type { DomDescriptor, ProjectInfo } from "./lib/types.ts";
import { api } from "./lib/api.ts";
import { ProjectBar } from "./components/ProjectBar.tsx";
import { BeforePreview } from "./components/BeforePreview.tsx";
import { AfterPreview } from "./components/AfterPreview.tsx";
import { Chat } from "./components/Chat.tsx";
import { StatusPanel } from "./components/StatusPanel.tsx";

export function App() {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<DomDescriptor | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api.status().then((s) => {
      setInfo(s.info);
      setHasKey(s.hasKey);
    });
  }, []);

  // 編集適用時に右(After)を更新するための合図 (US-005 が dispatch)
  useEffect(() => {
    const onApplied = () => setReloadKey((n) => n + 1);
    window.addEventListener("uim:applied", onApplied);
    return () => window.removeEventListener("uim:applied", onApplied);
  }, []);

  function onSelect(d: DomDescriptor) {
    setSelected(d);
    setSelectMode(false);
  }

  return (
    <div className="flex h-full bg-neutral-900 text-neutral-200">
      {/* 左: GUI 操作パネル */}
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-neutral-800">
        <ProjectBar
          info={info}
          hasKey={hasKey}
          busy={busy}
          setBusy={setBusy}
          onInfo={setInfo}
          onError={setError}
          selectMode={selectMode}
          setSelectMode={setSelectMode}
        />
        {error && (
          <div className="whitespace-pre-wrap border-b border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Chat selected={selected} hasKey={hasKey} />
        </div>
        <StatusPanel />
      </aside>

      {/* 中央: 編集前 */}
      <main className="min-w-0 flex-1 border-r border-neutral-800">
        <BeforePreview
          info={info}
          selectMode={selectMode}
          onSelect={onSelect}
        />
      </main>

      {/* 右: 変更後 */}
      <section className="min-w-0 flex-1">
        <AfterPreview info={info} reloadKey={reloadKey} />
      </section>
    </div>
  );
}
