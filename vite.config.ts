import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const SERVER_PORT = process.env.UIM_SERVER_PORT || "5174";
const CLIENT_PORT = Number(process.env.UIM_CLIENT_PORT || "5173");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: CLIENT_PORT,
    proxy: {
      "/api": {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
