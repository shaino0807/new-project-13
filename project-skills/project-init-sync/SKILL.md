# project-init-sync

Use this project-local skill when the user asks to initialize, restore, or sync this project's local Codex setup.

## Workflow

1. Read `AGENTS.md` first and preserve the project boundary rules.
2. Report existing and missing initialization files before editing.
3. Add only missing directories or files.
4. Do not overwrite `AGENTS.md`, `README.md`, `.gitignore`, `project-skills/`, `generated-skills/`, `.codex/skills/`, or `.agents/skills/`.
5. Use `scripts/project-init-sync.ps1` for the project initialization check.
6. Use `scripts/restore-skills.ps1` only when missing project skills should be copied into the user's global Codex skills folder.

## Commands

Inventory and create missing required folders:

```powershell
.\scripts\project-init-sync.ps1
```

Inventory, create missing required folders, and restore missing project skills:

```powershell
.\scripts\project-init-sync.ps1 -RestoreSkills
```
