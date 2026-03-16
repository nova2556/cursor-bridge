# Cursor Bridge Integration Report

## Status

In progress, with real `web_v1` validation completed for both stable CLI and interactive main flows.

## Static validation

Latest known status:
- `node --check` passes for current module set
- default `npm run selftest -- /home/rog/.openclaw/openclaw.json` passes (20/20)

## Real-session validation: `web_v1`

Environment summary:
- repo: `web_v1`
- cwd: `/mnt/e/voxa/web_v1`
- launch path: WSL -> Windows Cursor Agent
- default model observed: `sonnet-4.6`

## Validation set A — stable CLI lane

### `run-oneshot-summary`
Status: PASS

Observed behavior:
- returned a meaningful repository summary
- correctly identified the project as Synclip.ai / AI-driven video editing + content platform
- identified meaningful directories such as `backend/`, `backend/routes/openapi/`, `web/`, and `web/src/app/dev/`
- suggested realistic next engineering tasks (for example `/dev/usage` log display and watermarked file URL issues)

Assessment:
- stable CLI lane is not only functional, but already useful in practice

### `task mode=auto`
Status: PASS

Observed behavior:
- selected `mode=oneshot`
- selected `lane=stable-cli`
- produced a meaningful summary and next-step suggestion

Assessment:
- auto task policy behaves as intended in a real repo

## Validation set B — interactive lane main chain

### `start`
Status: PASS

### `send`
Status: PASS

Observed behavior:
- accepted prompt via `literal+Enter`
- returned populated `acceptanceHeuristics`

### `wait`
Status: PASS

Observed behavior:
- returned non-timeout result
- returned populated `completionHeuristics`
- captured meaningful content from a real agent turn

### `tail`
Status: PASS

Observed behavior:
- returned meaningful final content
- preserved raw output with pane/UI context

### `stop`
Status: PASS

Assessment:
- interactive session lifecycle main path is now working in real use for `web_v1`

## Validation set C — interactive task lane

### `task mode=interactive`
Status: PASS with quality caveat

Observed behavior:
- interactive task flow completes successfully
- result object is returned successfully
- session / send / wait / summary chain remains operational
- the agent performs real repository inspection (e.g. reading docs and listing repo directories)

Quality caveat:
- final `state.output` / synthesized summary can still collapse to an over-trimmed trailing fragment instead of preserving the strongest structured answer block
- this is a quality/extraction issue, not a task-flow failure

Suspected layers:
- `normalizeTaskInteractiveOutput`
- `extractLastAssistantAnswer`
- `synthesizeTaskSummary`

## Concrete evidence observed

### Stable CLI lane examples
- project correctly recognized as Synclip.ai
- key directories correctly surfaced
- realistic next tasks were identified from current repo context

### Interactive lane examples
- interactive wait/tail produced concrete content such as:
  - project purpose
  - key directory identification
  - evidence of file/directory inspection (`README.md`, `web/src/app`, `backend/routes`, etc.)

## Current conclusions

### Proven good enough in real use
- stable CLI lane
- `task auto` selecting stable CLI lane
- interactive lifecycle main path (`start -> send -> wait -> tail -> stop`)
- interactive task flow end-to-end execution

### Still worth improving
- interactive task final-answer extraction quality
- additional real validation for:
  - `resume`
  - `rules`
  - `commands`
  - `model`
  - `mcp`
  - `context`

## Highest-value next step

Improve interactive task result extraction so the final synthesized summary prefers the strongest structured answer block rather than a late trailing fragment.
