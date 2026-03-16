# Cursor Bridge Integration Checklist

This checklist is for real tmux + Cursor validation after the Phase 1 / Phase 2 refactor.

## Preconditions

- OpenClaw plugin loads successfully
- `tmux` is installed and usable
- Cursor binary is reachable
- Cursor Agent is authenticated
- At least one repo is configured in plugin config
- If using WSL -> Windows bridge, verify Windows-side Cursor Agent path is correct

## 1. Baseline health

- [ ] `npm run selftest -- /home/rog/.openclaw/openclaw.json` passes
- [ ] `openclaw plugins list` shows `cursor-bridge` loaded
- [ ] `/cursor status` returns healthy prereqs and configured repos
- [ ] `/cursor repos` returns the expected repo map

## 2. Interactive session lifecycle

### Start / attach / stop / quit
- [ ] `/cursor start <repo>` creates a live session
- [ ] `/cursor sessions` shows the session
- [ ] `/cursor attach <repo>` returns a valid tmux attach command
- [ ] `/cursor stop <repo>` stops the live session cleanly
- [ ] `/cursor quit <repo>` gracefully tears down the session and stream log

### Resume
- [ ] `/cursor history <repo>` returns usable conversation IDs
- [ ] `/cursor resume <repo>` resumes most recent conversation
- [ ] `/cursor resume <repo> :: <chat-id>` resumes a specific conversation
- [ ] `/cursor resume <repo> :: <chat-id> :: <prompt>` resumes and immediately continues work

## 3. Interactive messaging and observation

### Send / wait / tail
- [ ] `/cursor send <repo> :: <instruction>` is accepted reliably
- [ ] `acceptanceHeuristics` are populated in tool details
- [ ] `/cursor wait <repo> 60` completes or times out cleanly
- [ ] `completionHeuristics` are populated in tool details
- [ ] `/cursor tail <repo> 120` shows useful live output
- [ ] Long answers are still recoverable from raw/log output
- [ ] Empty or near-empty agent replies do not falsely report success

### Follow-up / prompt state
- [ ] Agent prompt is recognized when Cursor shows follow-up UI text
- [ ] Busy/idle transitions are not prematurely classified
- [ ] Stream log and pane output stay coherent after multiple sends

## 4. Interactive action helpers

### Slash / picker / context helpers
- [ ] `/cursor compress <repo>` sends `/compress`
- [ ] `/cursor rules <repo>` captures meaningful rules output
- [ ] `/cursor commands <repo>` captures meaningful command output
- [ ] `/cursor review <repo>` triggers review mode
- [ ] `/cursor model <repo>` opens model picker
- [ ] `/cursor model <repo> :: <model-name>` switches model successfully
- [ ] `/cursor context <repo> :: <path>` inserts context reference without accidental submit
- [ ] `/cursor mcp <repo> :: enable <server>` sends the correct MCP command

## 5. Stable CLI lane

### One-shot runs
- [ ] `/cursor run <repo> :: <prompt>` returns text output
- [ ] `/cursor run <repo> :: <prompt> format=json` returns JSON-formatted output
- [ ] `/cursor run <repo> :: <prompt> format=stream-json` returns stream-json output
- [ ] Timeouts are reported cleanly
- [ ] Transient network errors retry once and then surface clearly if still failing

### Models / login / update / history
- [ ] `/cursor models <repo>` lists available models
- [ ] `/cursor login` starts login flow in a dedicated session
- [ ] `/cursor update` runs successfully or fails cleanly with useful output
- [ ] `/cursor history <repo>` works for repos with real chat history

## 6. Task lane

### Auto / oneshot / interactive
- [ ] `/cursor task <repo> :: <goal>` defaults to stable CLI lane when appropriate
- [ ] `/cursor task <repo> :: <goal> mode=oneshot` stays in oneshot lane
- [ ] `/cursor task <repo> :: <goal> mode=interactive` uses live interactive flow
- [ ] Task summary contains lane + reliability metadata
- [ ] Task milestone inference is plausible for real outputs
- [ ] Task blocker / approval signals are surfaced correctly

## 7. WSL -> Windows bridge

- [ ] Windows Cursor Agent launches from WSL-managed tmux session
- [ ] `linuxToWindowsPath()`-style path translation works for configured repos
- [ ] `Set-Location` injection lands the agent in the correct working directory
- [ ] Git wrapper path (if enabled) behaves correctly
- [ ] PowerShell command quoting still works for prompts with punctuation / quotes

## 8. Regression scenarios

- [ ] Repeated `send` calls after prior task completion still work
- [ ] Reusing an existing live session does not corrupt baseline/stream offsets
- [ ] Switching from interactive use to oneshot use does not interfere with later sessions
- [ ] Killing an agent session does not leave stale stream state that breaks a future session

## 9. Evidence to capture during verification

For any failure, capture:
- command used
- repo key
- lane in use
- model in use
- tmux session name
- tool details payload
- relevant pane tail
- relevant stream log tail
- whether the issue was reproducible

## Exit criteria for engineering polish

The engineering-polish phase can be considered strong when:
- default selftest stays green
- the most common interactive paths pass manually
- stable CLI paths pass manually
- WSL -> Windows launch path is verified
- known flaky areas are at least documented with concrete reproduction notes
