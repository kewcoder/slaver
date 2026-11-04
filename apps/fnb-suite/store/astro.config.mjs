import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// SSR store. Runs under Bun as a child process of the main server (src/server.ts).
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  server: { host: "127.0.0.1", port: 4321 },
});
