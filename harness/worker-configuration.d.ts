import type { Sandbox } from "./src/index";

declare global {
  interface Env {
    Sandbox: DurableObjectNamespace<Sandbox>;
    DB: D1Database;
    JWT_SECRET: string;
  }
}

export {};
