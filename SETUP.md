# SETUP: manual steps for Bala

Numbered, copy-pasteable steps to get every account, key and machine NetSense needs. After each step, fill in the "What I saw / notes" box so the coding agent and future you know what happened.

Ground rules:
- Put values only in `.env.local` on your laptop, `/data/netsense/.env` on the VM (mode 600), the Convex dashboard env, and the Modal Secret. **Never in the repo, chat, tickets or commit messages.**
- Names to fill are listed in `.env.example`. `pnpm check:env` prints which names are missing (never values).
- Commands marked **UNTESTED** come from vendor docs and have not been run for this project yet; if one fails, use the vendor's current docs and note the fix in the box.
- Times are Singapore time (SGT).

Order: 0 → 1 → 4 → (5) first, because the M0 spike (due Wed 28 Oct 11:59 PM SGT) needs Meta and Modal. Then 2, 3, 6, 9, 10. Steps 7 and 8 are optional. Step 11 has recording tips for clips with coach commentary.

Note (v1.1): Codex can start the "Ready to test now" chunk (TASKS.md) with **no paid keys**; only step 0 is needed for that, and steps 2–3 (free Clerk and Convex dev accounts) for running the app and E2E. For each spike clip, click the one person to follow with `spike/pick_subject.py` (RUNBOOK §1.4).

---

## 0. Local tools (laptop)

```bash
node --version        # want v22.x
corepack enable && corepack prepare pnpm@latest --activate
curl -LsSf https://astral.sh/uv/install.sh | sh
ffmpeg -version | head -1
brew install gitleaks   # or: see https://github.com/gitleaks/gitleaks#installing
```
Yields: no env vars. Verify: each command prints a version.

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| Versions seen | |
| Problems | |

---

## 1. Meta Model API key and credits

1. Sign in to the Meta Model API developer console (link in the hackathon participant guide) with the account you registered for the hackathon.
2. Add a payment method if asked, and check whether hackathon credits are applied (D8). Write the credit balance below. **Status (28 Oct):** BLOCKED until you confirm: you are adding your card and activating the account yourself (relayed via Chief of Staff). Tell the team when it is active so T0.1/T0.3 can proceed.
3. Create an API key for **Standard** mode. Never use `-contributor` model IDs.
4. Set a Billing **Spend Limit notification** (it only alerts; the app enforces its own `DAILY_SPEND_LIMIT_USD`).
5. Put the key in `.env.local`:
```bash
MODEL_API_KEY=...            # from the console
META_API_BASE_URL=https://api.meta.ai/v1
```
Verify (**UNTESTED**: OpenAI-compatible models list):
```bash
set -a; source .env.local; set +a
curl -s "$META_API_BASE_URL/models" -H "Authorization: Bearer $MODEL_API_KEY" | python3 -m json.tool | grep -E '"id"' | grep -E 'muse-spark|muse-voice|sam-3'
```
Expect `muse-spark-1.3`, `muse-voice-transcribe-1.0`, `sam-3.1`.

Yields: `MODEL_API_KEY`, `META_API_BASE_URL`.

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| Credits / balance | |
| Models listed | |
| Spend Limit notification set to | |
| Problems | |

---

## 2. Clerk application (coach sign-in)

1. In the Clerk dashboard create an application "NetSense". Enable **Google** and **Email code**. Disable other methods.
2. Copy keys:
```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
```
3. Connect Convex: follow Convex's "Convex & Clerk" guide (activate the Convex integration or create a JWT template named `convex`). Copy the **Issuer** URL:
```bash
CLERK_JWT_ISSUER_DOMAIN=https://<your-instance>.clerk.accounts.dev
```
4. Later (T1.30): add the VM's public URL to allowed origins / redirect URLs, and create a production instance if you want one for the demo.
5. For screen 28 (extra only): on your own user, set public metadata `{"role":"dev"}`.

Verify: after T1.04, sign in at `http://localhost:3000/sign-in`; a `coaches` row appears in Convex.

Yields: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER_DOMAIN`.

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| Instance (dev / prod) | |
| Sign-in methods on | |
| Problems | |

---

## 3. Convex project and deploy

```bash
cd netsense            # repo root, after T1.01
pnpm dlx convex dev    # log in, create project "netsense"; writes CONVEX_DEPLOYMENT and NEXT_PUBLIC_CONVEX_URL to .env.local
```
Generate shared secrets and set Convex env (values go to Convex, not the repo):
```bash
for n in CONVEX_SERVICE_SECRET WORKER_TOKEN_SECRET LINK_CODE_PEPPER STUDENT_SESSION_SECRET MEDIA_URL_SIGNING_SECRET; do
  echo "$n=$(openssl rand -hex 32)" >> .env.local
done
set -a; source .env.local; set +a
pnpm dlx convex env set CLERK_JWT_ISSUER_DOMAIN "$CLERK_JWT_ISSUER_DOMAIN"
pnpm dlx convex env set CONVEX_SERVICE_SECRET "$CONVEX_SERVICE_SECRET"
pnpm dlx convex env set WORKER_TOKEN_SECRET "$WORKER_TOKEN_SECRET"
pnpm dlx convex env set LINK_CODE_PEPPER "$LINK_CODE_PEPPER"
```
Production (T1.30): in the Convex dashboard → Settings → create a **production deploy key** → `CONVEX_DEPLOY_KEY`; set the same env names on the prod deployment. `CONVEX_SITE_URL` is the deployment's `.convex.site` URL (HTTP actions).

Verify: `pnpm dlx convex env list` shows the names; dashboard shows tables after T1.03.

Yields: `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_SITE_URL`, `CONVEX_DEPLOY_KEY`, `CONVEX_SERVICE_SECRET`, `WORKER_TOKEN_SECRET`, `LINK_CODE_PEPPER`, `STUDENT_SESSION_SECRET`, `MEDIA_URL_SIGNING_SECRET`.

Note: free plan has 1 GB file storage and 1 GB egress; video never goes into Convex storage.

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| Dev deployment name | |
| Prod deployment created? | |
| Problems | |

---

## 4. Modal account, token and sandbox smoke test

1. Create or open your Modal workspace. Write the **workspace name** below (needed for the credit request; credits are pending).
2. Install and authenticate:
```bash
uv tool install modal
modal token new            # opens a browser; stores a token in ~/.modal.toml
```
For the VM, create a token in the Modal dashboard → Settings → API tokens:
```bash
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
MODAL_APP_NAME=netsense-runner
MODAL_RUNNER_SECRET_NAME=netsense-runner
MODAL_ENVIRONMENT=main
```
3. Create the runner secret in the Modal dashboard → Secrets → Custom: name `netsense-runner`, key `MODEL_API_KEY`. (Dashboard avoids putting the key in shell history.)
4. Smoke test (**UNTESTED**; save as `/tmp/modal_smoke.py`, outside the repo):
```python
import modal
app = modal.App.lookup("netsense-smoke", create_if_missing=True)
image = modal.Image.debian_slim().apt_install("ffmpeg")
sb = None
try:
    sb = modal.Sandbox.create("ffmpeg", "-version", app=app, image=image,
                              timeout=120, name="netsense-smoke")
    sb.set_tags({"app": "netsense", "env": "smoke"})
    sb.wait()
    print(sb.stdout.read().splitlines()[0])
finally:
    if sb is not None:
        sb.terminate()
print("released")
print("open sandboxes:", list(modal.Sandbox.list(app_id=app.app_id, tags={"app": "netsense"})))
```
```bash
uv run --with modal python /tmp/modal_smoke.py
```
Expect an ffmpeg version line, `released`, and an empty or finished-only list. Check the Modal dashboard: no running sandboxes, and note the cost.

Yields: `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `MODAL_APP_NAME`, `MODAL_RUNNER_SECRET_NAME`, `MODAL_ENVIRONMENT`, `SANDBOX_DRIVER=modal` (or `local` if Modal is not usable).

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| Workspace name | |
| Credits status | |
| Cold start (s) | |
| Released? running sandboxes after | |
| Problems | |

---

## 5. Storage: Cloudflare R2

S1 decided by Bala 28 Oct (relayed via Chief of Staff): Cloudflare R2, private, expiring links. `STORAGE_DRIVER=r2` is the default; `local` (`LOCAL_STORAGE_DIR`) is for laptop dev and tests only.

1. Cloudflare dashboard → R2 → create bucket `netsense-media` (private; no public access, no custom domain).
2. R2 → Manage API tokens → create a token with **Object Read & Write** scoped to that bucket only.
3. Bucket → Settings → CORS policy:
```json
[{"AllowedOrigins": ["http://localhost:3000", "https://<your-vm-public-url>"],
  "AllowedMethods": ["GET", "PUT", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3600}]
```
4. Env:
```bash
STORAGE_DRIVER=r2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=netsense-media
R2_ENDPOINT=https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
SIGNED_URL_TTL_SECONDS=600
```
Verify:
```bash
AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
  aws s3 ls "s3://$R2_BUCKET" --endpoint-url "$R2_ENDPOINT" --region auto && echo OK
```

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| S1 | R2 (decided 28 Oct) |
| Bucket / CORS set | |
| Problems | |

---

## 6. instabox VM

1. Create a machine (Debian 13, 4 vCPU / 8 GiB, 20 GiB `/data`) using the instabox dashboard or CLI per its docs. Write the machine name below.
2. **Plan (I1, decided by Bala 28 Oct (relayed via Chief of Staff)): free plan.** The VM pauses after 30 minutes idle and this cannot be turned off; Modal does the processing, so cost stays low. A visit to the public URL wakes it; wake it before every demo (RUNBOOK §3.3). (Only if you ever move to a paid plan: `instabox auto-suspend <machine> 0` turns auto-suspend off.)
3. On the VM:
```bash
sudo apt-get update && sudo apt-get install -y git curl ffmpeg build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo corepack enable
curl -LsSf https://astral.sh/uv/install.sh | sh
sudo mkdir -p /data/netsense && sudo chown "$USER" /data/netsense
install -m 600 /dev/null /data/netsense/.env   # then paste values with an editor; never echo secrets into history
```
4. After T1.30: clone the repo into `/data/netsense/app`, `pnpm install && pnpm build`, install `infra/vm/*.service` units, start them, expose the web port as the public URL.
5. Remember: public port URLs are not secret; every route checks auth.

Verify: `curl -s https://<public-url>/api/health` returns `{"ok":true,...}`; `systemctl status netsense-web netsense-orchestrator` are active.

Yields: `APP_BASE_URL`, `VM_API_BASE_URL`, `NETSENSE_ENV=prod` (prod uses `STORAGE_DRIVER=r2`; no `LOCAL_STORAGE_DIR` needed).

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| Machine name / public URL | |
| Plan (free / paid), auto-suspend | |
| Problems | |

---

## 7. Optional: Fireworks and Baseten (outside M1)

Only if credits arrive and an extra (X6) is started.
```bash
FIREWORKS_API_KEY=...
BASETEN_API_KEY=...
```
Verify with each provider's model-list or a one-line chat call; record the exact model id.

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| Credits / model ids | |
| Problems | |

---

## 8. Optional: Gemini (only if G1 = yes)

`DECISION PENDING (Bala)` G1, due Thu 29 Oct. If yes: create a Gemini API key, set `GEMINI_API_KEY`, and disclose it in the README (D9).

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| G1 decision | |
| Problems | |

---

## 9. GitHub repository settings (you do this; agents don't)

1. Create a new **public** repo (new work only). Push the local repo yourself when ready. (Done: https://github.com/balasivagn/netsense.)
2. Settings → Code security: enable **Secret scanning** and **Push protection**, Dependabot alerts.
3. Settings → Branches (or Rules → Rulesets): protect `main`: require a pull request before merging, require the CI check, block force pushes and deletions. Coding agents push only their own lane branches and open PRs; you review and merge (AGENTS.md rule 13). If Codex pushes as your own GitHub account, GitHub will not let you approve your own PR, so set required approvals to 0 and merge yourself after review; if Codex uses a separate bot account, require 1 approval (yours). **UNTESTED** for this repo.
4. Do not add any Actions secrets: CI runs with the fake provider only.
5. Description: "Coaching-workflow tool: turns a cricket coach's spoken remarks into a marked-up video and private lesson. Built for the Meta AI Developer Hackathon." Topics: `meta-ai`, `sam`, `cricket`, `coaching`.
6. Before making it public: `scripts/secret-scan.sh` clean; no media files (`git ls-files | grep -Ei '\.(mp4|mov|wav|m4a|webm)$'` prints nothing); decide P2 (wireframes in `docs/design/`).

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| Repo URL | |
| Secret scanning / push protection on | |
| Problems | |

---

## 10. Final check

```bash
cp .env.example .env.local   # only the first time; then fill values
pnpm check:env               # lists missing names
pnpm dev                     # app on http://localhost:3000
```
Remaining non-secret settings (pick values per SPEC §17–18, defaults there): `AGENT_PROVIDER_DEFAULT`, `SANDBOX_TIMEOUT_CAP_S`, `SANDBOX_IDLE_TIMEOUT_S`, `HEARTBEAT_S`, `HEARTBEAT_STALE_S`, `JOB_LEASE_S`, `JOB_MAX_ATTEMPTS`, `ORCH_POLL_INTERVAL_MS`, `SWEEPER_INTERVAL_S`, `LINK_TTL_DAYS`, `DAILY_SPEND_LIMIT_USD`, `JOB_SAM_FRAME_CAP`, `JOB_SPARK_TOKEN_CAP`, `FANOUT_CONCURRENCY`, `MAX_VIDEO_MINUTES`, feature flags.

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| Missing names | |
| Problems | |

---

## 11. Recording tips for clips with coach commentary

For spike, test and demo clips.

- At least 2 clips, about 5–10 min each, ≥ 5 remarks each. Adults who agreed to be filmed only, no minors (D3). Clips uploaded through the app need the consent checkbox on 06 ticked (C-C); spike clips used outside the app have no checkbox, so note the agreement off-app.
- The coach talks about **one player** (the one you will tap on 07a) while filming. Other people in frame are fine; they are ignored.
- Phone near the coach's voice (the coach films, or a second phone/mic close by); little wind; sound on.
- Camera still (tripod or fence mount), the player large in frame and not hidden behind the net post for long.
- Copy clips to `spike/clips/` (git-ignored) and fill the subject columns of `deliveries.csv` with `spike/pick_subject.py`.
- Pick the best one as the demo hero candidate.

Yields: no env vars. Verify: `uv run python spike/transcribe.py clips/<clip>.wav` prints turns (after step 1).

**What I saw / notes:**
| Item | Notes |
|---|---|
| Date / time (SGT) | |
| Clips recorded (count, length) | |
| Agreement notes kept off-app | |
| Problems | |
