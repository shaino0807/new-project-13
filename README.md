# New project 13

This project has been prepared for portable Codex skill restore.

## Purpose

This workspace hosts a public Taiwan stock technical-analysis Agent, AppDeploy deployment files, and reusable Codex workflow skills.

Public site:

```text
https://932f5348aea14e86a7.v2.appdeploy.ai/
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
