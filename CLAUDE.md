# Dev Dashboard — Code Review Interface

## What to build
A lightweight web dashboard for reviewing git diffs from Claude Code changes across multiple projects.

## Tech Stack
- **Backend:** Node.js + Express
- **Frontend:** Vanilla HTML/CSS/JS (no framework needed, keep it simple)
- **Auth:** Simple password protection (bcrypt hashed password)
- **Port:** 8090
- **No database** — reads git state directly from project directories

## Pages

### 1. Login Page
- Simple password input
- Session-based auth (express-session)
- Password stored as bcrypt hash in .env

### 2. Home / Dashboard
- List of configured projects (name, path, git branch, last activity)
- For each project: count of pending changes (uncommitted files)
- Click on a project -> Project Detail page

### 3. Project Detail
- Project name and info at top
- List of all change requests / uncommitted changes
- Each change shows:
  - Files modified (list)
  - Colored git diff (green = added, red = removed, like GitHub)
  - Timestamp
- Actions per change:
  - **Approve** button -> runs git add + git commit with a commit message input
  - **Reject** button -> runs git restore to discard all changes
  - **Instruct** button -> text input to give a new instruction (saves to a file that agents can pick up)

## Git Diff Display
- Use diff2html library for proper diff rendering
- Syntax highlighting
- Side-by-side or unified view toggle
- File tree on the left showing changed files

## Configuration
Projects configured in a config.json file with name, path, and description for each project. Pre-configure:
- Afdex: /home/openclaw/projects/afdex (STO Exchange Platform)
- Champion Spirit: /home/openclaw/projects/champion-spirit/api (Fitness Management Platform)

## Environment (.env)
- PORT=8090
- SESSION_SECRET (random string)
- AUTH_PASSWORD_HASH (bcrypt hash, use password "afdex2026" for now)

## Design
- Dark theme (developer-friendly)
- Clean, minimal UI
- Responsive
- Use CSS Grid/Flexbox for layout

## Security
- Password protected
- Session expires after 24h
- Only accessible on VPS
