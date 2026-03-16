# Cursor Bridge Refactor Notes

## Status

Phase 1 and the main body of Phase 2 are complete.

The plugin has been refactored from a single large implementation file into a lane-aware structure with dedicated modules for heuristics, interactive runtime state, interactive actions, CLI-style execution, and task orchestration.

## Main architectural conclusion

`cursor-bridge` serves two very different execution styles:

1. **Stable CLI / headless lane**
   - Best for automation and predictable completion
   - Includes: `run`, `task` in oneshot/auto mode, `models`, `update`, `history`-style command execution

2. **Interactive emulation lane**
   - Best-effort tmux-driven control of a live Cursor Agent session
   - Includes: `start`, `resume`, `send`, `tail`, `wait`, `compress`, `mcp`, `model`, `context`, `rules`, `commands`, `review`, `attach`, `quit`

The original code mixed these two styles too freely. The refactor makes the distinction explicit in both behavior and code organization.

## What changed

### 1. Lane-aware behavior

- Added lane metadata helpers:
  - `stableCliMeta()`
  - `interactiveMeta()`
- Interactive and CLI-like results now expose reliability intent more clearly.
- `task auto` now prefers the stable CLI lane unless interactive mode is explicitly requested or `taskPreferInteractive=true`.

### 2. Module split

The codebase is no longer centered on a single giant `index.ts` implementation.

Current extracted modules:

- `heuristics.ts`
  - output cleaning
  - pane heuristics
  - assistant answer extraction
- `interactive-runtime.ts`
  - stream log helpers
  - snapshot capture
  - output shaping
  - baseline / last-send trimming
- `interactive-actions.ts`
  - slash/picker/context/review style interactive actions
  - interactive result metadata helpers
- `cli-lane.ts`
  - `listHistory`
  - `listModels`
  - `runOneShot`
  - `loginAgent`
  - `updateAgent`
- `task-orchestrator.ts`
  - task spec compilation
  - task prompt construction
  - session choice
  - signal extraction
  - milestone inference
  - summary synthesis
  - task execution orchestration

`index.ts` now acts much more like an integration/registration layer with remaining shared glue.

### 3. Interactive session helpers

Shared interactive helpers now exist and are reused instead of being duplicated inline:

- `requireInteractiveSession()`
- `interactiveResult()`
- `runInteractiveSlashCommand()`

These back interactive action-style methods such as:
- `compressSession`
- `mcpControl`
- `switchModel`
- `addContext`
- `showRules`
- `showCommands`
- `reviewSession`

### 4. Interactive runtime observation helpers

Shared snapshot/output helpers now exist in `interactive-runtime.ts`:

- `captureInteractiveSnapshot()`
- `buildInteractiveOutput()`

These are used to unify the observation model for:
- `sendToAgent`
- `tailAgent`
- `waitForAgent`

### 5. Heuristic transparency

Interactive flows now expose more diagnostic data:

- `sendToAgent()` returns `acceptanceHeuristics`
- `waitForAgent()` returns `completionHeuristics`

This makes failures easier to diagnose without pretending the interactive lane is protocol-stable.

### 6. Selftest split and stabilization

`selftest.mjs` now defaults to static/pure-function coverage only.

Integration phases that depend on real tmux + Cursor behavior are opt-in via:

```bash
CURSOR_BRIDGE_SELFTEST_INTEGRATION=1 npm run selftest -- /home/rog/.openclaw/openclaw.json
```

Default static selftest command:

```bash
npm run selftest -- /home/rog/.openclaw/openclaw.json
```

## Current validation status

Default static selftest currently passes:

- passed: 20
- failed: 0

This validates at least the following:
- command parsing
- task spec compilation
- task summary synthesis
- heuristic cleaning behavior
- runtime helper output shaping
- static control-flow assumptions
- module import wiring across the current split

## Current structure summary

At this point, `index.ts` mainly retains:

- config normalization and shared types
- repo/path/tmux/process glue
- start/resume/stop/quit/attach orchestration
- command parsing
- plugin registration / command + tool entrypoints

This is a major reduction in responsibility compared with the original monolithic structure.

## Known remaining limitations

This refactor still does **not** fully solve deeper Cursor product-model gaps.

Still missing or incomplete:

- explicit queue vs immediate message semantics
- checkpoint awareness
- full protocol-like completion guarantees for interactive mode
- broader pure unit tests for all heuristics and module seams
- real integration regression coverage in CI or repeatable local automation
- further reduction of residual glue inside `index.ts`

## Recommended next phase

A future polish / Phase 3 should focus on:

1. expanding pure unit coverage for heuristic edge cases and module boundaries
2. reducing remaining glue density in `index.ts`
3. improving integration verification for real Cursor/tmux sessions
4. exploring official Cursor semantics more deeply where possible (queue/immediate/checkpoints)

## Repository note

This plugin is now maintained in its own git repository at this directory, with the refactor committed incrementally so each module extraction can be reviewed independently.
