# Cursor Bridge Refactor Notes

## Status

Phase 1 refactor is complete.

This phase focused on making the plugin easier to reason about and less misleading about reliability, without changing the overall public command surface.

## Main architectural conclusion

`cursor-bridge` serves two very different execution styles:

1. **Stable CLI / headless lane**
   - Best for automation and predictable completion
   - Includes: `run`, `task` in oneshot/auto mode, `models`, `update`

2. **Interactive emulation lane**
   - Best-effort tmux-driven control of a live Cursor Agent session
   - Includes: `start`, `resume`, `send`, `tail`, `wait`, `compress`, `mcp`, `model`, `context`, `rules`, `commands`, `review`, `attach`, `quit`

The old code mixed these two styles too freely. The refactor makes the distinction explicit.

## What changed

### 1. Lane-aware behavior

- Added lane metadata helpers:
  - `stableCliMeta()`
  - `interactiveMeta()`
- Interactive and CLI-like results now expose reliability intent more clearly.

### 2. Task policy

- `task auto` now prefers **stable one-shot CLI execution** by default.
- Interactive mode is only preferred when:
  - `mode=interactive` is explicit, or
  - `config.taskPreferInteractive=true`

### 3. Interactive session helpers

Added shared helpers to reduce repeated logic:

- `requireInteractiveSession()`
- `interactiveResult()`
- `runInteractiveSlashCommand()`

These now back the interactive action-style methods such as:
- `compressSession`
- `mcpControl`
- `switchModel`
- `addContext`
- `showRules`
- `showCommands`
- `reviewSession`

### 4. Interactive runtime observation helpers

Added shared snapshot/output helpers:

- `captureInteractiveSnapshot()`
- `buildInteractiveOutput()`

These are now used to unify the observation model for:
- `sendToAgent`
- `tailAgent`
- `waitForAgent`

### 5. Heuristic transparency

Interactive flows now expose more diagnostic data:

- `sendToAgent()` returns `acceptanceHeuristics`
- `waitForAgent()` returns `completionHeuristics`

This makes failures easier to diagnose without pretending the interactive lane is protocol-stable.

### 6. Selftest split

`selftest.mjs` now defaults to static/pure-function coverage only.

Integration phases that depend on real tmux + Cursor behavior are opt-in via:

```bash
CURSOR_BRIDGE_SELFTEST_INTEGRATION=1 npm run selftest -- /home/rog/.openclaw/openclaw.json
```

Default selftest command:

```bash
npm run selftest -- /home/rog/.openclaw/openclaw.json
```

## Current validation status

Default static selftest currently passes:

- passed: 20
- failed: 0

This validates:
- command parsing
- task spec compilation
- task summary synthesis
- noise cleaning
- prompt/heuristic cleaning basics
- static control-flow assumptions

## Known remaining limitations

This refactor does **not** fully solve the deeper Cursor product-model gaps yet.

Still missing or incomplete:

- explicit queue vs immediate message semantics
- checkpoint awareness
- full protocol-like completion guarantees for interactive mode
- dedicated modular file split (`interactive-runtime.ts`, `slash-actions.ts`, etc.)
- broader pure unit tests for all heuristic helpers
- real integration regression coverage in CI or repeatable local automation

## Recommended next phase

Phase 2 should focus on:

1. splitting large `index.ts` into smaller modules
2. expanding heuristic unit tests around:
   - `extractLastAssistantAnswer`
   - `paneLooksBusy`
   - `paneShowsInputPrompt`
   - output cleaning helpers
3. improving integration verification flows for real Cursor/tmux environments

## Repository note

This plugin is now maintained in its own git repository at this directory so future verification and commits are straightforward.
