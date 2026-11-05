# Slaver: Hackathon Submission

> **Meta Global AI Developer Hackathon 2026** · Track: **Build for Your World** · Indie Developer · Solo
> Tagline: **Don't just connect software. Own it.**
> Fill in every `TODO` before submitting.

---

## X post link (Most Viral Track)

TODO: https://x.com/<handle>/status/<id>

Draft post (fits in one tweet; attach the 30s customize clip):

> Small businesses rent software forever. Developers are watching AI eat their jobs.
>
> I built Slaver: an app marketplace where you **buy an app once, own the code, and change it by just asking**, powered by Meta's Muse Spark.
>
> "Make the store green and add a Ramadan promo" → live preview in ~1 min.
>
> #MetaAIHackathon @AIatMeta

---

## Project Description

**Slaver is an app marketplace where small business owners buy software once, own the source code, run it on their own server, and customize it in plain language. Meta's models review every app before it is listed and make the code changes.**

### The problem: two groups, one gap

1. **Business owners rent software forever.** A small restaurant in Indonesia pays monthly for a cashier app, a booking app, an online menu and a marketing tool. None of them fit exactly. The data lives on someone else's platform, and changing one button means hiring a developer they can't afford.
2. **Developers are losing their footing.** AI makes software cheaper to write, and many developers don't know how they will keep earning from the skills they built.

Today these two groups barely meet. App builders like Shopify lock you into their runtime. AI coding tools assume you know Git, Docker and a terminal, which a warung owner does not.

### The solution: a marketplace where Meta's models do the risky parts

**For developers (sellers):**
- Upload an app (git push, zip, or a public git URL) and request a listing.
- **Muse Spark reviews the submission.** Static checks run first (leaked secrets, README, runnable entry point, tests, file sizes), then the model reads the code and returns a score from 0 to 10, strengths, must-fix blockers and suggestions in the seller's language.
- **The review is a gate, not a decoration.** A listing can only go live when the latest review of the *current commit* is `approved`. Push new code and the old approval no longer counts.
- The same review runs on GitHub: opening a PR under `apps/<name>/` triggers `.github/workflows/app-review.yml`, which posts the review as a PR comment.

**For business owners (buyers):**
- Browse the marketplace, buy a license once (HitPay checkout: QRIS, bank transfer, e-wallet, cards), and get **their own private copy of the repo**.
- Install it in one click on **their own** Fly.io account. The customer's token is used and the customer is billed directly, so the app runs without Slaver in the middle.
- **Customize it by asking, Lovable-style:** *"Change the store color to green and add a Ramadan banner."*
  1. Muse Spark looks at the project's file list and picks the files to change (at most 6).
  2. It reads those files and rewrites them with the smallest correct change.
  3. Slaver commits the result to a **`staging` branch** with the prompt as the commit message.
  4. The branch is shipped to a **staging sandbox** in the customer's own Sprites account, then rebuilt and restarted, and the owner sees a live preview URL.
  5. When the owner is happy, **"Apply to production"** merges `staging` into `main`. Production stays untouched until then.
- Every change keeps the history of earlier changes, so follow-ups ("now make the banner smaller") build on what came before.

### Why this is different

- **Ownership, not rental:** the buyer gets source code plus deployment on their own infrastructure. There is no lock-in, and they can leave anytime.
- **Every AI action can be checked:** reviews are pinned to a commit SHA and stored. Every customization is a real git commit with a readable summary, a live preview and an explicit human approval before production.
- **Safe by design:** files that look like they contain secrets are never sent to the model, edits are limited to the files the model picked from the real tree (no path traversal), only owners and admins can customize, and only one change runs at a time.
- **Built for non-technical people:** the owner never sees Git, Docker or a terminal. The UI is bilingual (Bahasa Indonesia and English).

### First app on the marketplace: F&B Suite

To prove the loop end to end, we built and listed a real app: **F&B Suite** (`apps/fnb-suite/`). It is an all-in-one restaurant app with cashier/POS, tables and booking with deposit, an online store, promos, an AI table camera and AI ad copy, and everything is exposed over MCP with role checks. Demo data comes from the real menu of **Saung Ranggon**, a Sundanese restaurant. It went through the same AI review as any seller's app, and it is the app we customize live in the demo.

### What was built during the hackathon (Oct 27 – Nov 4)

All commits in this repo are from the building period (first commit Oct 29). Highlights:
- Marketplace listing flow with the **AI review gate** (`src/review.rs`, `scripts/review-app.ts`, `.github/workflows/app-review.yml`).
- **AI customize on staging + apply to production** (`src/customize.rs`).
- Git service (bare repos, upload, import, branches), licenses and **HitPay checkout** (`src/hitpay.rs`, `src/platform_api.rs`), one-click install to the customer's Fly.io (`src/hosting.rs`), "Login with Slaver" OAuth (`src/oauth.rs`).
- Seed app **F&B Suite** (`apps/fnb-suite/`).

---

## Public GitHub Repository

https://github.com/kewcoder/slaver

Key files for judges:
| What | Where |
|---|---|
| AI review of a listing (platform) | [`src/review.rs`](https://github.com/kewcoder/slaver/blob/main/src/review.rs) |
| AI review on PR (CI) | [`scripts/review-app.ts`](https://github.com/kewcoder/slaver/blob/main/scripts/review-app.ts), [`.github/workflows/app-review.yml`](https://github.com/kewcoder/slaver/blob/main/.github/workflows/app-review.yml) |
| AI customize → staging → production | [`src/customize.rs`](https://github.com/kewcoder/slaver/blob/main/src/customize.rs) |
| Meta Model API provider | [`src/provider.rs`](https://github.com/kewcoder/slaver/blob/main/src/provider.rs) |
| Seed marketplace app | [`apps/fnb-suite/`](https://github.com/kewcoder/slaver/tree/main/apps/fnb-suite) |

---

## 3-Minute Demo Video

TODO: https://youtube.com/watch?v=...

Script (the voice-over can follow the tone of `IDEAS.md`):

| Time | Scene | Shows |
|---|---|---|
| 0:00–0:25 | **The problem.** A restaurant paying four subscriptions; a developer wondering how to earn. "What if these two problems became one opportunity?" | Story |
| 0:25–1:00 | **Seller submits F&B Suite.** Request listing → static checks → Muse Spark review appears (score, strengths, must-fix). Show a version with a leaked key getting blocked, then the fixed commit getting `approved`. | AI review gate |
| 1:00–1:25 | **Buyer buys once.** Marketplace → HitPay checkout → their own repo copy → one-click install to their Fly.io. | Ownership |
| 1:25–2:25 | **Customize by asking.** Type *"Make the store green and add a Ramadan promo banner"* → steps update live ("Meta model is editing the code…", "Rebuilding…") → staging preview shows the change → open the commit with the diff → follow-up prompt → **Apply to production**. | Main moment |
| 2:25–2:45 | **The same review on GitHub.** A PR under `apps/` gets an automatic Muse Spark review comment. | Developer workflow |
| 2:45–3:00 | **Close.** "Developers become creators. Businesses own their technology. Don't just connect software. Own it." | Brand |

Recording tips: pre-warm the staging sandbox so the first build doesn't eat demo time, keep a fallback recording of the customize step, and show the Meta model name in the review card.

---

## Describe your use of Meta products to build the submitted project

Slaver uses the **Meta Model API** (`https://api.meta.ai/v1`, OpenAI-compatible Chat Completions) as its default AI provider. **Muse Spark 1.3** is the default model, and the model can be changed with `AI_TEXT_MODEL` (for example to **Muse Wonder** for bigger repos). Meta models do two core jobs, each with more than one step:

**1. Marketplace submission review (quality and safety gate)**
- Slaver walks the repo at HEAD, skips build output and lockfiles, and runs static checks. Files matching secret patterns (API keys, private keys, tokens) are **withheld from the model** and flagged as must-fix.
- It ranks files (README → manifests → entry points → source), sends the top 10 plus the full file tree, and asks Muse Spark for strict JSON: `score`, `summary`, `strengths`, `must_fix`, `suggestions`, written in the seller's language and limited to real file names.
- The verdict combines the static checks with the AI's must-fix list. The review is stored with the **commit SHA and model id**, and the listing cannot go live unless the current commit is approved.
- The same logic runs in CI (`scripts/review-app.ts`) and posts a PR comment.

**2. AI customization for buyers (agentic code editing)**
- **Step 1, planning:** Muse Spark gets the owner's request, the history of earlier changes and the project file tree, and returns up to 6 files to edit.
- **Step 2, editing:** Muse Spark gets the full contents of those files and returns complete new versions plus a one-line summary in the owner's language.
- Slaver validates the output (only files the model picked, no `..` paths, no empty files), commits it to `staging`, ships it to a sandbox, rebuilds, restarts and shows a live preview. A person approves the merge to production.

**Muse Code** — TODO: describe how you used it while building (e.g. which modules it helped write or refactor).

---

## Why are Meta's models important to your solution?

1. **They make the marketplace trustworthy enough to buy from.** A marketplace for self-hosted code only works if buyers trust what they install. Reviewing every submission by hand doesn't scale for a solo founder; Muse Spark reviewing every commit does, and it explains its decision in words a seller can act on.
2. **They turn "you own the code" into something a non-developer can use.** Owning source code is worthless if you can't change it. Muse Spark is what lets a restaurant owner edit their own app by describing what they want.
3. **Long context fits whole apps.** Muse Spark's 1M-token window means the reviewer and the editor see the full file tree and complete files, not fragments. Full-file rewrites stay consistent.
4. **Reliable structured output.** Both features depend on strict JSON (review fields, file lists, edits). Muse Spark's consistency is what lets us validate every response and keep an approval step for people.
5. **Cheap enough for a small business.** At $0.10 per 1M input tokens, a customization costs well under a cent, so an owner can iterate dozens of times without worrying about the bill.
6. **Open weights fit the "own it" promise.** Muse Spark Open and Muse Glimmer 30B are open-weight models, so the same pipeline can later run on a business's own hardware or on Fireworks, Baseten or Modal. Because the API is OpenAI-compatible, the code doesn't change. Fully owned software, including the AI.

---

## Feedback from your experience using partner technologies

TODO: personalize. Draft:

- **Meta Model API:** OpenAI compatibility made integration very fast. An existing Chat Completions client worked by changing the base URL and model id. One request: a first-class **JSON schema / structured output example for multi-step agent flows** in the cookbook. We parse JSON defensively today (stripping code fences and text around the object).
- **Muse Spark 1.3:** strong at "smallest correct change" edits and at following "only use real file names" rules. It sometimes wraps JSON in markdown fences, so a strict JSON mode would remove that handling.
- **Muse Code:** TODO.
- **Fireworks / Baseten / Modal:** Slaver ships provider presets for Baseten and Modal so teams can bring their own inference. TODO: add notes if you used the credits.
- **Others used:** HitPay (sandbox checkout + webhooks with HMAC), Fly.io (customer-owned deploys), Sprites (customer-owned staging sandboxes).
