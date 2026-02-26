import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";

const tauriConf = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "src-tauri/tauri.conf.json"), "utf8"),
);

export default defineConfig({
  plugins: [tailwindcss(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(tauriConf.version),
  },
  server: {
    host: "127.0.0.1",
    port: 14200,
    strictPort: true,
  },
});
