# New project 13

This project has been prepared for portable Codex skill restore.

## Purpose

This workspace hosts a public Taiwan stock technical-analysis Agent, AppDeploy deployment files, and reusable Codex workflow skills.

Public site:

```text
https://932f5348aea14e86a7.v2.appdeploy.ai/
```

GitHub Pages will publish a static build from the `main` branch after GitHub repo setup:

```text
https://<github-user>.github.io/<repo-name>/
```

## Work Mode

- Fixed project rules live in `AGENTS.md`.
- Progress, next steps, and pitfalls live in the Obsidian dashboard:

```text
G:\我的雲端硬碟\oB 與 Obsidian\Projects\New project 13\專案工作流程.md
```

- Say `開工` to resume from `AGENTS.md` plus the Obsidian dashboard.
- Say `收工` to update the dashboard and check Git status.
- Say `project-init-sync` to run a non-destructive initialization check.


## Portable project skills

Portable project-local skills live in:

```text
project-skills/
```

To restore skills on a new computer:

```powershell
.\scripts\restore-skills.ps1
```

The restore script copies missing skills into the user's global Codex skills folder and does not overwrite existing global skills.

## Project init sync

To run the non-destructive project initialization check:

```powershell
.\scripts\project-init-sync.ps1
```

To also restore missing project-local skills:

```powershell
.\scripts\project-init-sync.ps1 -RestoreSkills
```

## GitHub Status

Git is available locally. GitHub CLI currently has an invalid token, so repo creation, push, and GitHub Pages setup are blocked until re-authentication.

Firebase MCP is not used by default.

## GitHub Pages

GitHub Pages cannot run the AppDeploy backend. The Pages workflow therefore builds a static frontend into `_site/` and swaps the AppDeploy client bridge for a direct fetch bridge to:

```text
https://api-v2.appdeploy.ai/app/932f5348aea14e86a7
```

Build locally:

```powershell
.\scripts\build-github-pages.ps1
```

Publish path:

```text
.github/workflows/deploy-pages.yml
```

## Pitfalls Logged

- Do not commit `.appdeploy`; it contains the AppDeploy API key and must stay ignored.
- GitHub Pages is static hosting only. The stock quote and Agent endpoints still need AppDeploy or another backend.
- The AppDeploy public frontend URL may return HTML for direct `/api/...` probes; direct backend checks should use `https://api-v2.appdeploy.ai/app/<app-id>/api/...`.
- In browser code, `new URL("/api/quote", "https://api-v2.appdeploy.ai/app/<app-id>")` drops the `/app/<app-id>` path. Concatenate the AppDeploy API base and normalized route path instead.
- PowerShell console output can show mojibake even when browser DOM renders Traditional Chinese correctly; verify with UTF-8 reads or browser DOM checks.
- Windows PowerShell can corrupt non-ASCII text inside generated HTML/JS when a script is saved or interpreted with the wrong encoding. Prefer ASCII-safe Unicode escapes for generated inline JS.
- AppDeploy diff/upload can corrupt literal Chinese or escaped newlines in fragile patches; use ASCII-safe escaping for risky remote patches and verify the rendered page.
- `gh auth status` can report an active account with an invalid token. Do not claim repo creation, push, Pages, or Actions succeeded until `gh auth status` is clean.
- Avoid broad `git add .`; this repo often has generated browser snapshots and unrelated deployment artifacts in the worktree.
