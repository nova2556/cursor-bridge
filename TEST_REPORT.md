# cursor-bridge test report

Date: 2026-03-10
Plugin version: 0.6.0
Environment: WSL2 (Ubuntu) + Windows Cursor CLI via PowerShell wrapper

---

## Overall status

| Area | Status |
|------|--------|
| Plugin infrastructure | ✅ pass |
| open (now alias for start) | ✅ updated — no longer spawns GUI |
| Agent TTY fix | ✅ implemented and verified |
| WSL path handling (linuxToWindowsPath) | ✅ implemented |
| agentWindowsBin auto-wrap (powershell + Set-Location) | ✅ implemented and now used in live config |
| repo:subdir subproject syntax | ✅ implemented |
| Interactive session lifecycle | ✅ pass — live tested on `web_v1` |
| initialPrompt (start ::) | ✅ implemented |
| quit (graceful exit) | ✅ implemented |
| History (agent ls via tmux) | ✅ reimplemented via tmux |
| Resume (specific / latest) | ✅ implemented and working |
| Models listing | ⚠️ depends on agent CLI version |
| One-shot run (tmpfile output) | ✅ implemented — output redirected to tmpfile, user-facing output cleaned, raw CLIXML kept separately |
| wait semantics | ✅ strengthened — answer + prompt required, plus last-send scoped extraction |
| tail extraction | ✅ improved — answer block extraction + UI filtering + startup-baseline trimming |
| send submission reliability | ✅ strengthened — fallback submit methods |
| compress / mcp / model | ✅ implemented |
| context / rules / commands / review | ✅ implemented |
| API key injection | ✅ implemented (masked in display, all agent cmds) |
| attach (tmux attach-session cmd) | ✅ implemented |
| resume with initialPrompt (:: chatId :: prompt) | ✅ implemented |
| history structured parse (entries + raw) | ✅ implemented |
| End-to-end agent response | ✅ verified in selftest |

---

## Test 1: Command parsing

**Command:** (internal, via `parseCommandArgs`)

**Cases tested:**

| Input | Expected action | Result |
|-------|----------------|--------|
| `status` | `{ action: "status" }` | ✅ |
| `repos` | `{ action: "repos" }` | ✅ |
| `sessions` | `{ action: "sessions" }` | ✅ |
| `help` | `{ action: "help" }` | ✅ |
| `login` | `{ action: "login" }` | ✅ |
| `update` | `{ action: "update" }` | ✅ |
| `open workspace` | `{ action: "run", subaction: "open", repo: "workspace" }` (→ startAgent) | ✅ |
| `start workspace` | `{ action: "run", subaction: "start", repo: "workspace" }` | ✅ |
| `start workspace model=sonnet-4.6` | `{ ..., model: "sonnet-4.6" }` | ✅ |
| `start workspace :: 先分析项目` | `{ ..., initialPrompt: "先分析项目" }` | ✅ |
| `start workspace :: 先分析项目 model=sonnet-4.6` | `{ ..., initialPrompt: "先分析项目", model: "sonnet-4.6" }` | ✅ |
| `start workspace:backend` | `{ action: "run", subaction: "start", repo: "workspace-backend" }` (subdir key) | ✅ |
| `history workspace:api` | `{ action: "history", repo: "workspace-api" }` | ✅ |
| `stop workspace` | `{ action: "run", subaction: "stop", repo: "workspace" }` | ✅ |
| `quit workspace` | `{ action: "quit", repo: "workspace" }` | ✅ |
| `send workspace :: do the thing` | `{ action: "send", repo: "workspace", text: "do the thing" }` | ✅ |
| `tail workspace 120` | `{ action: "tail", repo: "workspace", lines: 120 }` | ✅ |
| `tail workspace` | `{ action: "tail", repo: "workspace", lines: 80 }` (default) | ✅ |
| `wait workspace 60` | `{ action: "wait", repo: "workspace", waitSec: 60 }` | ✅ |
| `wait workspace` | `{ action: "wait", repo: "workspace", waitSec: 120 }` (default) | ✅ |
| `history workspace` | `{ action: "history", repo: "workspace" }` | ✅ |
| `resume workspace` | `{ action: "resume", repo: "workspace", chatId: "" }` | ✅ |
| `resume workspace :: abc123` | `{ action: "resume", repo: "workspace", chatId: "abc123" }` | ✅ |
| `resume workspace :: abc123 model=gpt-5` | `{ ..., model: "gpt-5" }` | ✅ |
| `models workspace` | `{ action: "models", repo: "workspace" }` | ✅ |
| `model workspace` | `{ action: "model", repo: "workspace" }` | ✅ |
| `model workspace :: sonnet-4.6` | `{ action: "model", repo: "workspace", modelName: "sonnet-4.6" }` | ✅ |
| `run workspace :: fix the bug` | `{ action: "run-oneshot", repo: "workspace", text: "fix the bug", waitSec: 120, outputFormat: "text" }` | ✅ |
| `run workspace :: audit format=json wait=300` | `{ ..., outputFormat: "json", waitSec: 300 }` | ✅ |
| `run workspace :: check format=stream-json` | `{ ..., outputFormat: "stream-json" }` (adds --stream-partial-output) | ✅ |
| `compress workspace` | `{ action: "compress", repo: "workspace" }` | ✅ |
| `context workspace :: src/Login.tsx` | `{ action: "context", repo: "workspace", contextPath: "src/Login.tsx" }` | ✅ |
| `rules workspace` | `{ action: "rules", repo: "workspace" }` | ✅ |
| `commands workspace` | `{ action: "commands", repo: "workspace" }` | ✅ |
| `review workspace` | `{ action: "review", repo: "workspace" }` | ✅ |
| `mcp workspace :: enable my-server` | `{ action: "mcp", repo: "workspace", mcpAction: "enable", mcpServer: "my-server" }` | ✅ |
| `mcp workspace :: disable old-server` | `{ action: "mcp", ..., mcpAction: "disable", mcpServer: "old-server" }` | ✅ |
| `unknown workspace` | `{ action: "error", message: "Unknown subcommand: unknown" }` | ✅ |
| `send workspace` (missing `::`) | `{ action: "error" }` | ✅ |
| `context workspace` (missing `::`) | `{ action: "error" }` | ✅ |
| `mcp workspace` (missing `::`) | `{ action: "error" }` | ✅ |

---

## Test 2: status

**Command:** `/cursor status`

**Checks:**
- tmux available in PATH ✅
- Cursor binary responds to `--version` ✅
- Agent binary/command responds to `--version` (depends on agentCommand) ⚠️
- Configured repos listed with existence check ✅
- Active tmux sessions listed ✅
- `CURSOR_API_KEY` injected if `apiKey` set in config ✅

**Expected output shape:**
```
Cursor Bridge status
- enabled: yes
- binary: /mnt/c/Users/rog/.../cursor
- version: Cursor x.x.x
- allowAgent: yes
- agentBinary: agent
- agentCommand: '...' -NoLogo ... agent.cmd
- agentVersion: x.x.x
- tmuxPrefix: cursor
- prereqs: ok
- repos: 1
- activeSessions: 0

Repos:
- workspace: /home/rog/.openclaw/workspace
```

---

## Test 3: repos

**Command:** `/cursor repos`

**Checks:**
- Returns list of `alias: /resolved/path` ✅
- Paths are resolved (absolute) ✅

---

## Test 4: sessions

**Command:** `/cursor sessions`

**Checks:**
- Returns empty list when no sessions running ✅
- Returns session list filtered by `tmuxPrefix` ✅
- Shows session name, window count, creation time ✅

---

## Test 5: open (alias for start)

**Command:** `/cursor open workspace`

`open` is now an alias for `startAgent` — it does not spawn the Cursor GUI. It creates a tmux session, cd-s to the project directory, and launches the agent with the same logic as `start`.

**Expected output:**
```
Started Cursor agent session
- repo: workspace
- cwd: /home/rog/.openclaw/workspace
- session: cursor-workspace
```

**Status:** ✅ implemented — `openRepo()` now calls `startAgent()` internally

---

## Test 6: start / isAgentAlive

**Command:** `/cursor start workspace`  
**Command:** `/cursor start workspace :: <initial-prompt> [model=<model>]`

### Root cause of previous failure (fixed)

The original implementation passed `agent` as the initial command to `tmux new-session -d`:
```bash
# OLD (broken):
tmux new-session -d -s cursor-workspace -c /path bash -lc "'agent'"
```
This runs the agent without a TTY. The agent CLI requires a real PTY and exits immediately. The session reverts to a bare bash shell. All subsequent `send` inputs were received by bash directly, causing syntax errors:
```
Please reply with a one-line acknowledgment...
bash: syntax error near unexpected token `do'
```

### Fix applied

```bash
# NEW (correct):
tmux new-session -d -s cursor-workspace -c /path          # bare shell
sleep startDelaySec                                         # wait for shell ready
tmux send-keys -t cursor-workspace "CURSOR_API_KEY=*** 'agent' --model ..." Enter
sleep trustDelaySec                                         # wait for agent UI
# only send 'a' if pane contains trust dialog text:
if pane matches /trust workspace|workspace trust/i:
    tmux send-keys -t cursor-workspace "a"
```

### initialPrompt support

If `start :: <prompt>` syntax is used, after liveness check passes the prompt is sent immediately:
```bash
tmux send-keys -t session -l -- "<prompt>"
tmux send-keys -t session Enter
```

### isAgentAlive() heuristic

After fix, `startAgent` also checks liveness before reusing a session:
- Captures last 20 lines of pane
- If last non-empty line matches `[$%#>]\s*$` AND no **specific** agent UI markers → agent has exited
- Specific markers used: `●`, `◆`, `Working`, `Thinking`, spinner chars `⠋⠙⠹…`, model name keywords (`claude`, `gpt-`, `sonnet`, `opus`, `haiku`, `gemini`), agent input prompt `^> `
- Removed the broad `cursor` and `agent` keywords that could match shell prompts, file paths, etc.
- Dead sessions are killed and restarted cleanly

**Status:** ✅ implemented and structurally correct

---

## Test 7: send

**Command:** `/cursor send workspace :: <text>`

**How it works:**
1. Checks session exists (tmuxSessionExists)
2. Sends text via `tmux send-keys -t <session> -l -- <text>`
3. Sends Enter

**Status:** ✅ implemented

---

## Test 8: tail

**Command:** `/cursor tail workspace [lines]`

**How it works:**
- `tmux capture-pane -t <session> -p -S -<lines>`
- Output truncated to 16000 chars if needed
- Returns raw pane content including any ANSI markup

**Status:** ✅ implemented and working (tested via selftest and manual runs)

---

## Test 9: wait

**Command:** `/cursor wait workspace [seconds]`

**How it works:**
- Polls pane every 3 seconds
- Checks for busy markers: `Working`, `Thinking`, `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`
- Two consecutive non-busy polls = agent done
- Returns final pane capture plus `timedOut` flag

**Status:** ✅ implemented

---

## Test 10: stop

**Command:** `/cursor stop workspace`

**Checks:**
- If session exists: kills it, returns `stopped: true` ✅
- If no session: returns `stopped: false` (no error) ✅

---

## Test 11: quit

**Command:** `/cursor quit workspace`

**How it works:**
1. Sends `Ctrl+C` twice (300ms apart) — interrupts any running agent task
2. Sends `Ctrl+D` twice (500ms/800ms apart) — EOF signal asks agent to exit gracefully
3. `kill-session` — force-cleans up the tmux session regardless

**Difference vs `stop`:** `stop` is an immediate hard kill. `quit` gives the agent a chance to finish and clean up before the session is destroyed.

**Status:** ✅ implemented

---

## Test 12: history

**Command:** `/cursor history workspace`

### Previous issue (fixed)

The original implementation used `runShell` to run `agent ls`, which executes without a TTY. `agent ls` uses Ink TUI and requires raw mode, so it always failed with:
```
Raw mode is not supported on the current process.stdin
```

### Fix applied

`listHistory` now spawns a temporary tmux session (identical pattern to `loginAgent`) and runs `agent ls` inside it via `send-keys`, giving it a real PTY:

```
cursor-ls-<timestamp>   ← temporary tmux session
  send-keys: "agent ls" Enter
  poll up to 6 × 1s for UUID pattern in pane
  kill-session on exit (finally block)
```

**Polling stops when:**
- Pane contains a UUID-pattern (`[0-9a-f]{8}-[0-9a-f]{4}`) ← conversation IDs found
- Pane contains `no conversations` / `empty` / `no chats` ← confirmed empty list
- 6 seconds elapsed ← timeout, return whatever was captured

**Output:** List of past conversations with chat IDs. IDs can be copied directly into `/cursor resume <repo> :: <chat-id>`.

**Status:** ✅ reimplemented via tmux — live result depends on agent version support

---

## Test 13: resume

**Command:**
- `/cursor resume workspace` → `agent resume` (most recent)
- `/cursor resume workspace :: abc123` → `agent --resume=abc123`
- `/cursor resume workspace :: abc123 model=gpt-5` → `agent --model gpt-5 --resume=abc123`
- `/cursor resume workspace :: abc123 :: 继续之前的任务` → resume then immediately send prompt

**How it works:**
1. Checks no live session exists (if alive, throws — must stop first)
2. Kills any dead session
3. Creates bare tmux session
4. Sends resume command via send-keys (with optional `CURSOR_API_KEY=...` prefix)
5. Conditionally accepts workspace trust prompt

**Verified working:** Screenshot evidence shows `agent --resume=2f89b160-12d6-47b7-afcf-cca35a50bff6` launched successfully and resumed an existing conversation (Claude 4.6 Opus model, project `E:\voxa\web_v1`).

**Key point:** Resume loads Cursor's **stored conversation history from disk**. The chat ID refers to a past conversation, not a tmux session. tmux sessions and agent conversations are independent layers.

**Status:** ✅ implemented and verified working

---

## Test 14: models

**Command:** `/cursor models workspace`

**How it works:**
- Runs `agent --list-models` non-interactively via `runShell` (pure stdout, no TTY needed)
- `CURSOR_API_KEY` injected if configured
- Returns list of available model names

**Status:** ✅ implemented — live result depends on agent version

---

## Test 15: model (switch in live session)

**Command:**
- `/cursor model workspace` → sends `/models` Enter (opens picker)
- `/cursor model workspace :: sonnet-4.6` → sends `/models` Enter, waits 800ms, types model name, Enter

**How it works:**
- Checks agent is alive (throws if not)
- Sends `/models` slash command to the interactive session
- If model name provided: types it into the picker after a short delay

**Status:** ✅ implemented — best-effort (picker UI is text-based, exact name match required)

---

## Test 16: run (one-shot)

**Command:** `/cursor run workspace :: <task> [model=<model>] [format=<text|json|stream-json>] [wait=<seconds>]`

**How it works:**
1. Creates a unique ephemeral tmux session (`cursor-workspace-run-<timestamp>`)
2. Builds launch command via `buildAgentLaunch` (includes Set-Location for WSL + apiKey injection)
3. Redirects output to a tmpfile: `agent -p "<task>" ... --force > /tmp/cursor-run-*.out 2>&1`
4. Polls pane until shell prompt returns (`[$%#>]\s*$`) — 2 consecutive idle polls = done
5. Reads tmpfile for clean output (no TUI escape codes, no pane noise)
6. Deletes tmpfile and kills session

**Why tmpfile instead of pane capture:**
`tmux capture-pane` mixes TUI escape codes, spinners, and intermediate status lines into the output. For `format=json` or `format=stream-json`, this made the JSON unreadable. The tmpfile approach captures only what `agent -p` writes to stdout/stderr.

**Flags:**
- `--stream-partial-output` added automatically when `format=stream-json`
- `--force` auto-applies all file changes without confirmation

**Status:** ✅ implemented — significantly improved output reliability over previous pane-capture approach

---

## Test 17: compress

**Command:** `/cursor compress workspace`

**How it works:**
- Checks agent is alive (throws if not)
- Sends `/compress` Enter to the live session

**Status:** ✅ implemented

---

## Test 18: context

**Command:** `/cursor context workspace :: src/components/Login.tsx`

**How it works:**
- Checks agent is alive (throws if not)
- Types `@src/components/Login.tsx` into the input (via `send-keys -l`)
- Sends a trailing space — registers the context reference without submitting

**Note:** Does not submit. Follow up with `/cursor send` to add text and send the message.

**Status:** ✅ implemented

---

## Test 19: rules

**Command:** `/cursor rules workspace`

**How it works:**
- Checks agent is alive (throws if not)
- Sends `/rules` Enter
- Waits 600ms, captures last 40 lines of pane

**Status:** ✅ implemented

---

## Test 20: commands

**Command:** `/cursor commands workspace`

**How it works:**
- Checks agent is alive (throws if not)
- Sends `/commands` Enter
- Waits 600ms, captures last 50 lines of pane

**Status:** ✅ implemented

---

## Test 21: review

**Command:** `/cursor review workspace`

**How it works:**
- Checks agent is alive (throws if not)
- Sends `Ctrl+R` (tmux key name `C-r`) to trigger inline diff/review mode

**Status:** ✅ implemented

---

## Test 22: mcp

**Command:** `/cursor mcp workspace :: enable my-server`

**How it works:**
- Checks agent is alive
- Sends `/mcp enable my-server` Enter (or disable)

**Status:** ✅ implemented

---

## Test 23: login

**Command:** `/cursor login`

**How it works:**
1. Creates ephemeral tmux session (`cursor-login-<timestamp>`)
2. Sends `agent login` via send-keys
3. Waits 4 seconds for browser redirect to trigger
4. Captures pane (may contain auth URL or instructions)
5. Returns output — session stays alive for manual interaction

**Note:** The login session is not managed by the repo-scoped session logic. Clean it up manually with `tmux kill-session -t cursor-login-...` after auth, or use `/cursor quit` if you renamed it.

**Status:** ✅ implemented

---

## Test 24: update

**Command:** `/cursor update`

**How it works:**
- Runs `agent update` via `runShell` with extended timeout (max of `timeoutSec` and 60s)
- `CURSOR_API_KEY` injected if configured
- Returns stdout/stderr

**Status:** ✅ implemented

---

## Test 25: API key injection

**Config:** `"apiKey": "sk-xxx"`

**How it works:**
- All `runShell` / `runQuick` calls receive `apiKey` and inject `CURSOR_API_KEY=<value>` into the child process env
- `buildAgentLaunch` handles injection per mode:
  - Linux-native: prepends `CURSOR_API_KEY=<value> ` to the shell command
  - `agentWindowsBin`: injects `$env:CURSOR_API_KEY='<value>'; ` into the PowerShell -Command string
  - `agentCommand` with PowerShell: injects same `$env:CURSOR_API_KEY=...` before the existing command content
- Display output always shows `CURSOR_API_KEY=***` / `$env:CURSOR_API_KEY=***` (masked), never the real value

**Status:** ✅ implemented

---

## Test 26: linuxToWindowsPath

**Function:** `linuxToWindowsPath(linuxPath)`

**Cases:**

| Input | Expected | Result |
|-------|----------|--------|
| `/mnt/e/voxa/web_v1` | `E:\voxa\web_v1` | ✅ |
| `/mnt/c/Users/rog` | `C:\Users\rog` | ✅ |
| `/mnt/c` | `C:` | ✅ |
| `/home/rog/project` | `/home/rog/project` (unchanged) | ✅ |
| `relative/path` | `relative/path` (unchanged) | ✅ |

**Status:** ✅ implemented and covered in selftest

---

## Test 27: agentWindowsBin + Set-Location injection

**Config:**
```json
{
  "agentWindowsBin": "C:\\Users\\rog\\AppData\\Local\\cursor-agent\\agent.cmd",
  "apiKey": "sk-xxx",
  "defaultModel": "sonnet-4.6"
}
```

**Repo:** `web_v1` → `/mnt/e/voxa/web_v1`

**Expected generated command sent via `send-keys`:**
```
powershell.exe -NoLogo -NoProfile -Command "$env:CURSOR_API_KEY='sk-xxx'; Set-Location 'E:\voxa\web_v1'; & 'C:\Users\rog\AppData\Local\cursor-agent\agent.cmd' --model 'sonnet-4.6'"
```

**Display output (masked):**
```
powershell.exe -NoLogo -NoProfile -Command "$env:CURSOR_API_KEY=***; Set-Location 'E:\voxa\web_v1'; & 'C:\Users\...\agent.cmd' --model 'sonnet-4.6'"
```

**Key properties verified:**
- `Set-Location` uses Windows path (`E:\...`), not Linux path (`/mnt/e/...`) ✅
- `$env:CURSOR_API_KEY` set before agent launch ✅
- `--model` flag appended ✅
- API key masked in display ✅

**Status:** ✅ implemented

---

## Test 28: repo:subdir syntax

**Config repos:**
```json
{
  "web_v1": "/mnt/e/voxa/web_v1"
}
```

**Cases:**

| Command repo arg | resolveRepo key | resolveRepo cwd |
|-----------------|-----------------|-----------------|
| `web_v1` | `web_v1` | `/mnt/e/voxa/web_v1` |
| `web_v1:backend` | `web_v1-backend` | `/mnt/e/voxa/web_v1/backend` |
| `web_v1:frontend/src` | `web_v1-frontend-src` | `/mnt/e/voxa/web_v1/frontend/src` |

- tmux session name uses the sanitised key: `cursor-web_v1-backend`
- Path existence check applied to the resolved subdir
- Works with all commands: `start`, `send`, `tail`, `run`, `history`, `resume`, etc.

**Status:** ✅ implemented and covered in selftest

---

## Self-test script

Run the automated smoke test:

```bash
cd ~/.openclaw/extensions/cursor-bridge
node ./selftest.mjs ~/.openclaw/openclaw.json workspace
```

The self-test covers:
- Command parsing: all variants including `repo:subdir`, model flags, initialPrompt, resume chatId
- `linuxToWindowsPath` utility
- Status · repos · sessions before/after start
- Start (with and without initialPrompt) · send · wait · tail
- Compress · mcp · context · rules · commands · review
- History · resume (latest) · one-shot run (tmpfile)
- Quit · stop · open (alias for start)

Exit code 0 = all pass. Non-zero = failures listed in JSON output.

Optional: enable the `open` step (which now calls `startAgent`) with:
```bash
CURSOR_BRIDGE_SELFTEST_OPEN=1 node ./selftest.mjs ~/.openclaw/openclaw.json workspace
```

---

## Final live validation on `web_v1`

Latest end-to-end verification against the real `web_v1` repo (without modifying existing source files; only using `tmp-cursor-bridge/`) confirmed:

- `wait_read.output = "CB_ABSOLUTE_FINAL_READ_OK"`
- `tail_read.output = "CB_ABSOLUTE_FINAL_READ_OK"`
- `wait_resume.output = "CB_FINAL_RESUME_OK"`
- `tail_resume.output = "CB_FINAL_RESUME_OK"`
- `oneshot.output = "CB_ABSOLUTE_FINAL_ONESHOT_OK"`
- `tmp-cursor-bridge/output.md`, `output2.md`, and `output-final.md` were created successfully during live write tests

This closes the previously remaining polish items:
- first-turn interactive extraction no longer returns startup pane noise in user-facing output
- one-shot output no longer exposes CLIXML/progress noise in user-facing output

## Full manual verification sequence

Run these in order to verify the complete feature set:

### Phase 1: infrastructure

```text
/cursor status                              ← check prereqs, binary versions, repo paths
/cursor repos                               ← list configured repos
/cursor sessions                            ← should be empty
/cursor models workspace                    ← list available models
```

### Phase 2: open / start

```text
/cursor open workspace                      ← alias for start; creates tmux session + launches agent
/cursor start workspace                     ← same as open
/cursor start web_v1:backend                ← subproject start (resolves to web_v1/backend)
/cursor sessions                            ← should now show cursor-workspace
```

### Phase 3: interactive session

```text
/cursor send workspace :: Please reply with exactly: CURSOR_BRIDGE_OK. Do not modify files.
/cursor wait workspace 60                   ← poll until agent responds
/cursor tail workspace 120                  ← should contain CURSOR_BRIDGE_OK
```

### Phase 4: start with initial prompt

```text
/cursor quit workspace
/cursor start workspace :: Please reply with exactly: CURSOR_BRIDGE_INIT_OK. Do not modify files.
/cursor wait workspace 60
/cursor tail workspace 60                   ← should contain CURSOR_BRIDGE_INIT_OK
```

### Phase 5: model switching

```text
/cursor models workspace                    ← list models
/cursor model workspace :: sonnet-4.6       ← switch model in live session
/cursor send workspace :: What model are you using right now?
/cursor wait workspace 30
/cursor tail workspace 40
```

### Phase 6: context and slash commands

```text
/cursor rules workspace                     ← show /rules output
/cursor commands workspace                  ← show /commands output
/cursor context workspace :: README.md      ← attach context reference
/cursor send workspace :: 简单介绍一下这个文件
/cursor wait workspace 30
/cursor tail workspace 60
```

### Phase 7: review

```text
/cursor review workspace                    ← trigger Ctrl+R inline review
/cursor tail workspace 20                   ← check pane for review mode indicator
```

### Phase 8: context window

```text
/cursor compress workspace                  ← send /compress
/cursor tail workspace 40                   ← should show compress acknowledgment
```

### Phase 9: history and resume

```text
/cursor quit workspace                      ← graceful exit (history persists on disk)
/cursor sessions                            ← should be empty
/cursor history workspace                   ← list past conversations, note a chat ID (UUID)
/cursor resume workspace                    ← resume most recent
/cursor send workspace :: What did we discuss before?
/cursor wait workspace 60
/cursor tail workspace 120
```

### Phase 10: specific resume with model

```text
/cursor stop workspace
/cursor resume workspace :: <chat-id-from-history> model=sonnet-4.6
/cursor send workspace :: Continue from where we left off.
/cursor wait workspace 60
```

### Phase 11: one-shot (tmpfile output)

```text
/cursor run workspace :: Please reply with exactly: CURSOR_BRIDGE_OK. Do not modify files.
← output read from tmpfile, should contain CURSOR_BRIDGE_OK
/cursor run workspace :: List the top-level files in this repo format=json
/cursor run workspace :: Summarise this codebase format=stream-json wait=90
```

### Phase 12: MCP

```text
/cursor start workspace
/cursor mcp workspace :: enable my-mcp-server
/cursor tail workspace 20                   ← confirm /mcp command acknowledged
```

### Phase 13: subproject

```text
/cursor start web_v1:backend :: 检查一下这个目录的结构
/cursor wait web_v1-backend 60
/cursor tail web_v1-backend 60
/cursor quit web_v1-backend
```

### Phase 14: cleanup

```text
/cursor quit workspace
/cursor sessions                            ← should be empty
```

---

## Known limitations

### WSL + Windows CLI: use agentWindowsBin for simplest setup

For WSL environments, the recommended config is now `agentWindowsBin` (Windows path to `agent.cmd`) rather than hand-crafting `agentCommand`. The plugin auto-generates the correct PowerShell invocation with `Set-Location` injected.

Live local config has now been migrated to `agentWindowsBin`, and the full selftest still passes in that mode.

If using `agentCommand`, ensure it contains `powershell` — the plugin will then inject `Set-Location` automatically. If `agentCommand` does not contain `powershell`, it is treated as a Linux-native command and `cwd` is set via tmux `-c` only (no Windows-side cd).

### isAgentAlive() is heuristic

The liveness check reads the last 20 lines of the tmux pane and looks for specific agent UI markers (spinner chars, model name keywords, `●`, `◆`, `Working`, `Thinking`, `^> ` prompt). The previous use of broad keywords `cursor` and `agent` was removed as they could match shell prompts or path strings, causing false-alive reads.

Remaining false-positive risk: agent is idle with none of these markers visible in the last 20 lines. Mitigation: the check is only used for "should we reuse this session?" — a false positive means we reuse a dead session once, which will fail on the next `send` and surface an error.

### history polling window

`listHistory` polls for up to 6 seconds for UUID-formatted chat IDs to appear in the pane. If the agent version renders the list slowly or uses a different format, the poll may time out and return partial or empty output. In that case, use `/cursor resume workspace` (no ID) to resume the most recent conversation.

### One-shot `run` completion detection

`agent -p` output is redirected to a tmpfile. Completion is detected by watching the pane for a bare shell prompt (`$`/`#`/`>`) returning — 2 consecutive idle polls = done. If the agent output is very slow and the prompt takes a long time to appear, the poll may time out before the tmpfile is fully written. Increase `wait=<seconds>` for long-running tasks.

### context reference not auto-submitted

`/cursor context` types `@<path> ` into the input box but does not press Enter. This is intentional — it lets you add additional text or attach multiple context references before sending. Follow up with `/cursor send` to submit.
