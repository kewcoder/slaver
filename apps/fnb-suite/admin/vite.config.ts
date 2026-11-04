import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the Bun server under /admin.
export default defineConfig({
  root: __dirname,
  base: "/admin/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/mcp": "http://localhost:8080" } },
});
