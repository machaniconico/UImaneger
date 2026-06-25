import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 依存はリポジトリルートの node_modules から解決される (hoisted)。
export default defineConfig({
  plugins: [react()],
});
