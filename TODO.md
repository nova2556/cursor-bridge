# cursor-bridge TODO — completion status

## Result

The previously-open reliability TODOs for cursor-bridge are now closed.

Interactive tmux-backed workflow is the canonical mode again, with one-shot `run` kept as a reliable fallback.

Latest live validation on `web_v1` now also confirms:
- [x] first-turn `wait` / `tail` extraction returns the actual answer text rather than startup pane noise
- [x] one-shot `run` output is cleaned for user-facing display, with raw CLIXML retained only in `rawOutput`

---

## Closed items

### End-to-end workflow
- [x] `startAgent()` + `sendToAgent()` + `waitForAgent()` + `tailAgent()` works end-to-end on `web_v1`
- [x] Follow-up prompts remain usable in the same session
- [x] One-shot `runOneShot()` remains a working fallback

### Interactive submit path
- [x] Reworked `sendToAgent()` to verify that the pane actually changed after submission
- [x] Added multi-strategy submit fallback chain:
  - [x] `send-keys -l` + `Enter`
  - [x] `send-keys -l` + `C-m`
  - [x] tmux `paste-buffer` + `Enter`
- [x] Added a short delay between text injection and submit key
- [x] Fail fast with captured pane output if Cursor appears not to accept the prompt

### Output detection / waiting
- [x] `waitForAgent()` now uses normalized pane capture instead of raw tmux text
- [x] Busy detection includes `Working` / `Thinking` / `Generating` / `Indexing` / spinner / `ctrl+c to stop`
- [x] Completion now requires both:
  - [x] visible assistant answer content
  - [x] visible follow-up prompt returning
- [x] `waitForAgent()` returns extracted answer text, with raw pane retained separately
- [x] Capture depth increased beyond the older `-S -120` heuristic

### Tail / capture quality
- [x] Added ANSI/UI normalization helpers
- [x] Added filtering for UI chrome / footer noise / box drawing
- [x] Added `extractLastAssistantAnswer()` helper
- [x] `tailAgent()` now prefers the useful answer region over raw pane scaffolding
- [x] Added session baseline + last-send anchoring so first-turn extraction does not get polluted by startup pane content
- [x] `waitAgent()` / `tailAgent()` now return clean answer text while preserving scoped raw pane output for debugging

### Canonical workflow decision
- [x] Interactive tmux session remains the primary supported workflow
- [x] Repeatable selftest passes against live `web_v1`
- [x] One-shot mode kept as fallback, not promoted as replacement

### Environment / ergonomics
- [x] Real Windows-side agent flow verified against `web_v1`
- [x] Supporting commands (`history`, `resume`, `model`, `mcp`, `compress`, `context`, `rules`, `commands`, `review`) remain covered by selftest
- [x] `agentWindowsBin` path remains available as the cleaner future config path even though current config still works with `agentCommand`

---

## Definition of done checklist

- [x] `start web_v1`
- [x] `send web_v1 :: <prompt>` actually executes
- [x] `wait web_v1` blocks until answer is really done
- [x] `tail web_v1` shows the answer instead of mostly UI scaffolding
- [x] second follow-up prompt also works
- [x] `run web_v1 :: <prompt>` still works as reliable fallback
- [x] no known false-success state in the tested flow

---

## Remaining future improvements

These are no longer blockers, just optional polish:

- [ ] Investigate the Cursor-side git warning in more detail (`E:\voxa\web_v1` is a real git repo, but the agent UI still sometimes says cwd is not a git repository)
- [x] Migrate local config from `agentCommand` to `agentWindowsBin` for a cleaner setup
- [ ] Add richer parsing for multi-message threads or especially long answers
