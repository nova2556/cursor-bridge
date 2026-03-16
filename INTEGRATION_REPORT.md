# Cursor Bridge Integration Report

## Status

In progress.

This report is the running companion to `INTEGRATION_CHECKLIST.md`.

## Static validation

Latest known status:
- `node --check` passes for current module set
- default `npm run selftest -- /home/rog/.openclaw/openclaw.json` passes (20/20)

## Manual / real-session verification

### Not yet fully executed in this report

The following still require real Cursor/tmux validation in the target environment:
- interactive session lifecycle
- interactive send/wait/tail reliability
- slash/picker helper actions
- stable CLI lane against real agent runtime
- task lane under real repo conditions
- WSL -> Windows bridge behavior under actual agent execution

## What is already strong

- lane split is explicit
- core modules are separated
- static task logic is covered
- interactive runtime helpers are shared
- interactive actions are centralized
- CLI lane is separated
- task orchestration is separated

## Highest-value next real-world checks

1. `/cursor start <repo>`
2. `/cursor send <repo> :: <prompt>`
3. `/cursor wait <repo> 60`
4. `/cursor tail <repo> 120`
5. `/cursor run <repo> :: <prompt>`
6. `/cursor task <repo> :: <goal>`
7. `/cursor rules <repo>` and `/cursor commands <repo>`
8. WSL -> Windows launch path sanity

## Recording template

For each real failure capture:
- command
- repo
- lane
- session
- model
- tool details
- pane tail
- stream tail
- reproducibility
- suspected layer (`heuristics` / `interactive-runtime` / `interactive-actions` / `cli-lane` / `task-orchestrator`)
