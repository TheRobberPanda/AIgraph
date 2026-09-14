import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  // Shown bottom-right, so a screenshot says which build it came from.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Tauri expects a fixed port and should fail loudly rather than drift to
  // another one, since tauri.conf.json points at 1420.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
