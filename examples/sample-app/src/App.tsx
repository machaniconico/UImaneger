import { useState } from "react";

// UImaneger のお試し用サンプル。プレビュー上で要素を選び自然言語で編集してみてください。
// 例:「見出しを大きく赤く」「ボタンを角丸にして影をつけて」「カードの背景を薄い青に」
export function App() {
  const [count, setCount] = useState(0);

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        minHeight: "100vh",
        margin: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f5f5",
      }}
    >
      <div
        style={{
          background: "#fff",
          padding: "32px 40px",
          borderRadius: 8,
          boxShadow: "0 1px 4px rgba(0,0,0,.1)",
          textAlign: "center",
        }}
      >
        <h1 style={{ margin: "0 0 8px", color: "#222" }}>サンプルアプリ</h1>
        <p style={{ color: "#666", marginTop: 0 }}>
          要素を選んで自然言語で編集してみよう
        </p>

        <button
          onClick={() => setCount((c) => c + 1)}
          style={{
            marginTop: 16,
            padding: "8px 20px",
            fontSize: 16,
            border: "none",
            background: "#4f8cff",
            color: "#fff",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          カウント: {count}
        </button>
      </div>
    </div>
  );
}
