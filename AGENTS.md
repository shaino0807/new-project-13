# New project 13 Agent Rules

## Project Boundary

Primary project folder:

`	ext
C:\Users\shaino\Documents\New project 13
`


## Project-local Skill Portability

project-skills/ is the portable source of truth for project-local skills.

Do not delete, overwrite, or regenerate an existing SKILL.md without first reporting:

- the existing path
- what would change
- whether the change is required

When restoring this project on a new machine, run:

`powershell
.\scripts\restore-skills.ps1
`

The restore script copies missing project skills into:

`	ext
C:\Users\<user>\.codex\skills
`

Existing global skills are not overwritten.

If project initialization is requested later:

- first report existing/missing files
- only add missing items
- do not overwrite AGENTS.md, README.md, .gitignore, project-skills/, generated-skills/, .codex/skills/, or .agents/skills/
- preserve existing project rules and only make small additive improvements

## Project Init Sync

- Project name: `New project 13`
- Purpose: public Taiwan stock technical-analysis Agent and reusable Codex skill/deployment workflow workspace.
- Main working directory: `C:\Users\shaino\Documents\New project 13`
- Default branch: `main`
- GitHub repo: pending; GitHub CLI token is currently invalid, so repo creation/push/Pages are blocked until `gh auth login -h github.com` is refreshed.
- GitHub Pages: workflow prepared at `.github/workflows/deploy-pages.yml`; it publishes a static `_site/` artifact built by `scripts/build-github-pages.ps1`.
- Primary public deployment: AppDeploy, currently `https://932f5348aea14e86a7.v2.appdeploy.ai/`.
- Obsidian vault: `G:\我的雲端硬碟\oB 與 Obsidian`
- Obsidian project dashboard: `Projects/New project 13/專案工作流程.md`
- Firebase MCP: 未使用.

## Work Mode

- 開工: read this `AGENTS.md`, then read the Obsidian project dashboard before making changes.
- 收工: update the Obsidian project dashboard, record pitfalls, and check `git status --short`.
- 新專案初始化 / project-init-sync: use the global `project-init-sync` skill and preserve existing files.
- Only stage files directly related to the active task. Do not use broad `git add .` when unrelated worktree changes exist.

## Main Files

- `index.html`: public frontend for the stock technical-analysis Agent.
- `backend/index.ts`: AppDeploy backend quote and Agent API.
- `src/main.ts`: AppDeploy client bridge.
- `tests/tests.txt`: AppDeploy QA tests.
- `project-skills/`: portable project-local skills.
- `scripts/project-init-sync.ps1`: non-destructive project initialization check.
- `scripts/build-github-pages.ps1`: builds the static GitHub Pages artifact with a direct AppDeploy API bridge.
- `scripts/restore-skills.ps1`: restore missing project-local skills to the user's global Codex skills folder.

## Safety Rules

- Do not commit `.appdeploy`, API keys, tokens, `.env`, private credentials, `.codex/`, or `.agents/` runtime state.
- Do not overwrite project-local skills or generated skill files without first reporting what would change.
- Do not set up Firebase unless the user explicitly asks.
- If GitHub authentication is broken, report it as blocked instead of pretending repo, push, or Pages operations succeeded.

## Pitfalls

- `.appdeploy` contains the AppDeploy API key. Keep it ignored and never commit or print it in handoff notes.
- GitHub Pages cannot host the AppDeploy backend; Pages must use a static frontend plus the AppDeploy API base.
- AppDeploy public frontend `/api/...` paths can return the app shell HTML; direct API probes should use `https://api-v2.appdeploy.ai/app/<app-id>/api/...`.
- Do not use `new URL("/api/...", appDeployApiBase)` in the Pages bridge because it strips the `/app/<app-id>` segment.
- PowerShell output may display Chinese as mojibake even when UTF-8 source and browser rendering are correct.
- Generated inline JS should avoid literal non-ASCII text under Windows PowerShell; use Unicode escapes so GitHub Pages artifacts do not inherit mojibake.
- Remote AppDeploy patches can mangle literal Chinese or escaped newlines; verify with rendered DOM checks after deployment.
- Treat invalid `gh` tokens as a hard blocker for repo creation, push, GitHub Pages activation, and Actions verification.
