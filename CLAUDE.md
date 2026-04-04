# Tested by E2E-TEST-001 pipeline
# OpenClaw Dev Dashboard

Personal dashboard for Ashwin — project management, code review, trading bot monitoring, invoicing, news feed, and more.

## Architecture

```
server.js                 ← Thin orchestrator (~100 lines): middleware, route mounting, server start
routes/
  auth.js                 ← Login, logout, session, passkeys (WebAuthn), password change
  projects.js             ← Git operations: status, diff, approve, reject, instruct, push, pull, branches, checkout, commits
  chat.js                 ← Claude Code chat via WebSocket: spawn claude CLI, session persistence, resume
  tasks.js                ← Project tasks + personal tasks CRUD with notes
  news.js                 ← News articles CRUD, aggregated feed from fetch-news.py, like/dislike, AI summarize
  integrations.js         ← Trading bot proxy, EQS car listings, Pronote children, worker proxy, notifications
  invoices.js             ← Invoice CRUD, events timeline (sent/reminder/paid), client management
  uploads.js              ← Audio transcription (OpenAI Whisper or local), file attachments
  synapcoin.js            ← SynapCoin marketing: activities CRUD, community platform stats, aggregated metrics
  synaphive.js            ← SynapHive marketing: activities CRUD, community platform stats, aggregated metrics
lib/
  git.js                  ← Safe git execution via execFile (no shell). Branch/hash validation.
  json-store.js           ← Atomic JSON read/write (write-to-temp + rename)
public/
  js/common.js            ← Shared frontend: auth guard, clock, toast, escapeHtml, hamburger menu, createSmartInterval
  css/style.css           ← Global dark theme (Catppuccin-inspired), all component styles
  home.html               ← Main dashboard: stats, tasks, facturation, trading bot, news feed, EQS, children, dev summary
  dashboard.html          ← Dev projects list view (/dev route)
  project.html            ← Project detail: git diff, commits, tasks, chat, approve/reject
  chat.html               ← Chat interface with Claude Code (WebSocket streaming)
  profile.html            ← User settings: password change, passkey management
  login.html              ← Auth entry point (password + passkey)
  pms-compare.html        ← Static PMS comparison table
  synapcoin-marketing.html ← SynapCoin marketing dashboard: activity log, community stats, launch plan (Tailwind + Chart.js)
  synaphive-marketing.html ← SynapHive marketing dashboard: activity log, community stats, launch plan (Tailwind + Chart.js)
  sw.js                   ← Service worker: network-first, caches static assets
config.json               ← Project definitions (id, name, path, repos, URLs)
data/                     ← Runtime data (gitignored): news.json, invoices.json, eqs-listings.json, children.json, synapcoin/, synaphive/
.dashboard/               ← App state (gitignored): personal-tasks.json, passkeys.json, notifications.json, audio/
scripts/                  ← Python scripts: fetch-eqs.py, fetch-pronote.py, fetch-news.py
```

## Tech Stack

- **Backend:** Node.js + Express 4
- **Frontend:** Vanilla HTML/CSS/JS — no framework, no build step
- **Auth:** bcrypt password + WebAuthn passkeys, express-session (24h cookie)
- **Real-time:** WebSocket (ws) for Claude Code chat streaming
- **Storage:** JSON files with atomic writes (no database)
- **External APIs:** Trading bot (FastAPI on 45.77.131.11:8000), OpenAI Whisper
- **Port:** 8090

## Key Conventions

### Backend

- Every route file exports a factory function: `module.exports = function({ config, requireAuth, ... }) { return router; }`
- Git commands MUST use `lib/git.js` (execFile with argument arrays) — NEVER use template string interpolation with exec/execAsync for user-supplied values (branch names, messages, hashes)
- JSON file writes MUST use `lib/json-store.js` writeJSON() for atomic writes
- Auth middleware: `requireAuth` (session only), `requireAuthOrBearer` (session or Bearer token for agent API)
- Rate limiting on `/api/login` (10 attempts / 15 min)
- Secrets in `.env` only — never hardcode tokens or keys in source

### Frontend

- All pages include `<script src="/js/common.js"></script>` before page-specific scripts
- Use `initCommon(callback)` to set up auth guard, clock, logout, hamburger menu
- Use `escapeHtml(str)` for all user-facing content in innerHTML
- Use `createSmartInterval(fn, ms)` instead of `setInterval` for auto-refresh (pauses when tab is hidden)
- Use CSS variables (`var(--text)`, `var(--bg)`, `var(--border)`, etc.) — never hardcode hex colors in inline styles
- Toast: `showToast('message', 'success'|'error')`
- Modal pattern: use `.news-modal-overlay` / `.news-modal-box` classes for full-screen modals

### CSS Variables (Dark Theme)

```css
--bg: #0d1117            --bg-surface: #161b22      --bg-card: #1c2128
--text: #e6edf3          --text-muted: #8b949e      --accent: #58a6ff
--green: #3fb950         --red: #f85149             --yellow: #d29922
--purple: #bc8cff        --border: #30363d
```

## Environment (.env)

```
PORT=8090
SESSION_SECRET=<random string>
AUTH_PASSWORD_HASH=<bcrypt hash>
OPENAI_API_KEY=<OpenAI key for Whisper transcription>
CLAUDE_CODE_OAUTH_TOKEN=<Anthropic OAuth token for Claude CLI>
WEBAUTHN_RP_ID=dashboard.infozen-consulting.com
WEBAUTHN_ORIGIN=https://dashboard.infozen-consulting.com
SYNAPCOIN_DOCS_PATH=/home/node/.openclaw/workspaces/synapcoin-docs
```

## Configured Projects

| ID | Name | Path | Description |
|----|------|------|-------------|
| afdex | Afdex | /home/openclaw/projects/afdex | STO Exchange Platform |
| champion-spirit | Champion Spirit | /home/openclaw/projects/champion-spirit/api | Fitness Management Platform (multi-repo: api, app, docker) |
| trading-bot | Trading Bot | /home/openclaw/projects/trading-bot | Futures Trading Bot - ETHUSDC Binance |
| stho | STHO | /home/openclaw/projects/stho/api | STHO Global Platform (multi-repo: api, web, infra) |
| openclaw-dashboard | OpenClaw Dashboard | /home/openclaw/projects/dev-dashboard | This dashboard itself |
| synapcoin | SynapCoin | /home/openclaw/projects/synapcoin | ERC-20 utility token for agent-to-agent economy |
| synaphive | SynapHive | /home/openclaw/projects/synaphive | AI Skills Marketplace |

## API Routes Summary

| Method | Path | Module | Description |
|--------|------|--------|-------------|
| POST | /api/login | auth | Password login |
| POST | /api/logout | auth | Destroy session |
| GET | /api/session | auth | Check auth status |
| POST | /api/profile/password | auth | Change password |
| POST | /api/passkeys/* | auth | WebAuthn register/auth |
| GET | /api/projects | projects | List all projects with git status |
| GET | /api/projects/:id | projects | Project detail with diff |
| POST | /api/projects/:id/approve | projects | Git add + commit |
| POST | /api/projects/:id/reject | projects | Git restore + clean |
| POST | /api/projects/:id/push | projects | Git push |
| POST | /api/projects/:id/checkout | projects | Switch branch |
| POST | /api/projects/:id/chat/start | chat | Start Claude chat session |
| WS | /ws/chat/:sessionId | chat | WebSocket for Claude streaming |
| GET/POST/PUT/DELETE | /api/projects/:id/tasks/* | tasks | Project task CRUD |
| GET/POST/PUT/DELETE | /api/personal/tasks/* | tasks | Personal task CRUD |
| GET/POST/PUT/DELETE | /api/news/* | news | News articles + feed |
| GET/POST/PATCH/DELETE | /api/invoices/* | invoices | Invoice + client management |
| GET | /api/trading-status | integrations | Trading bot KPIs, positions, trades |
| GET | /api/eqs | integrations | EQS car listings |
| GET | /api/children | integrations | Pronote children data |
| GET | /api/synapcoin/stats | synapcoin | Aggregated marketing stats |
| GET/POST | /api/synapcoin/activities | synapcoin | List / create marketing activities |
| PUT/DELETE | /api/synapcoin/activities/:id | synapcoin | Update / delete activity |
| GET | /api/synapcoin/community | synapcoin | List community platforms with follower counts |
| PUT | /api/synapcoin/community/:platform | synapcoin | Update community platform data |
| GET | /api/synapcoin/docs | synapcoin | List files in SYNAPCOIN_DOCS_PATH |
| GET | /api/synapcoin/docs/:filename | synapcoin | Download a document file |
| GET | /api/synaphive/stats | synaphive | Aggregated marketing stats |
| GET/POST | /api/synaphive/activities | synaphive | List / create marketing activities |
| PUT/DELETE | /api/synaphive/activities/:id | synaphive | Update / delete activity |
| GET | /api/synaphive/community | synaphive | List community platforms with follower counts |
| PUT | /api/synaphive/community/:platform | synaphive | Update community platform data |

## Security Rules

1. **No shell injection**: Use `lib/git.js` for all git commands. Validate branch names with `validateBranchName()`, hashes with `validateHash()`.
2. **No hardcoded secrets**: All tokens/keys go in `.env`. Reference via `process.env.VARIABLE_NAME`.
3. **Escape user content**: Always use `escapeHtml()` before inserting user data in innerHTML.
4. **Atomic file writes**: Use `writeJSON()` from `lib/json-store.js` to prevent data corruption.
5. **Rate limiting**: Login endpoint is rate-limited. Add rate limiting to any new sensitive endpoints.
