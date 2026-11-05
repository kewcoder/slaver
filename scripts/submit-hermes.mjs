#!/usr/bin/env node
// Submit Hermes Agent (Nous Research, MIT) to a Slaver marketplace as the
// "Slaver Labs" seller, through the same API a seller's browser uses.
//
//   LABS_PASSWORD=... node scripts/submit-hermes.mjs <base-url> <hermes.tar.gz> [--publish]
//
// 1st run: creates labs@slaver.app + team "Slaver Labs", the "Hermes Agent"
// listing, and uploads the snapshot (a GitHub tarball of one commit, no history:
// the full repo history is ~1.4 GB). Restart the server so the boot seed adds
// the listing review, then run again with --publish (the review gate still applies).
import { readFileSync } from "node:fs";

const [base, tarball] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const publish = process.argv.includes("--publish");
const password = process.env.LABS_PASSWORD;
if (!base || !password) {
  console.error("usage: LABS_PASSWORD=... node scripts/submit-hermes.mjs <base-url> <hermes.tar.gz> [--publish]");
  process.exit(1);
}

const EMAIL = "labs@slaver.app";
const NAME = "Hermes Agent";
const SHA = process.env.HERMES_SHA ?? "";
const DESCRIPTION =
  "Self-hosted AI companion by Nous Research (MIT license), submitted by Slaver Labs. It remembers you across sessions, learns new skills from experience, runs scheduled tasks, and chats with you on Telegram, WhatsApp, Discord, Slack or Signal. Bring any model, including Meta's. Upstream: github.com/NousResearch/hermes-agent" +
  (SHA ? ` @ ${SHA.slice(0, 8)}` : "") +
  ".";

let token = "";
async function call(name, args = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${name}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result.data;
}

try {
  token = (await call("auth_login", { email: EMAIL, password })).token;
} catch {
  token = (await call("auth_register", { email: EMAIL, password, name: "Slaver Labs" })).token;
  console.log("registered", EMAIL);
}

const teams = (await call("team_list")).teams;
let team = teams.find((t) => t.name === "Slaver Labs");
if (!team) {
  team = (await call("team_create", { name: "Slaver Labs" })).team;
  console.log("team created", team.id);
}

const repos = (await call("repos_list", { team_id: team.id })).repos;
let repo = repos.find((r) => r.name === NAME);
if (!repo) {
  repo = (await call("repos_create", { team_id: team.id, name: NAME, description: DESCRIPTION })).repo;
  console.log("listing created", repo.id);
}
await call("repos_update", { repo_id: repo.id, description: DESCRIPTION, price_cents: 0, category: "AI" });

if (tarball && !publish) {
  const body = readFileSync(tarball);
  const msg = encodeURIComponent(`Hermes Agent snapshot${SHA ? ` ${SHA}` : ""} (github.com/NousResearch/hermes-agent)`);
  const res = await fetch(`${base}/api/repos/${repo.id}/upload?message=${msg}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/gzip" },
    body,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`upload: ${j.error}`);
  console.log("uploaded", j.sha);
}

const review = (await call("listing_review_get", { repo_id: repo.id })).review;
console.log("review:", review ? `${review.verdict} ${review.score}/10 model=${review.model || "-"} current=${review.current}` : "none yet");

if (publish) {
  await call("repos_publish", { repo_id: repo.id, template: true });
  console.log("published", repo.id);
}
