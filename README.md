# cursor-bridge

A full-featured OpenClaw plugin that bridges chat commands to Cursor IDE and its CLI agent for whitelisted repos.

## What it does

- Starts one persistent `agent` session per repo inside tmux by **cd-ing to the project directory and running the agent command** — not by launching the GUI
- Automatically converts WSL Linux paths (`/mnt/e/...`) to Windows paths (`E:\...`) and injects `Set-Location` into PowerShell invocations so the agent always runs in the correct project context
- Supports a new `agentWindowsBin` config that makes WSL→Windows agent setup one field to fill in (no manual PowerShell command construction needed)
- Supports `repo:subdir` syntax for subproject targets — e.g. `web_v1:backend` resolves to `repos.web_v1/backend`
- Automatically handles workspace trust prompt on first run (`a` keypress after configurable delay)
- Detects dead agent sessions via pane content heuristics and restarts them cleanly
- Sends an optional initial prompt immediately after a session starts (`start :: <prompt>`)
- Sends follow-up edit instructions into a live interactive session, with fallback submit strategies when Cursor Ink input is finicky
- Captures recent session output back into chat (`tail`), now using a dual-path strategy: tmux pane extraction for cleaned final answers plus a tmux `pipe-pane` stream log for in-progress/live feedback; first-turn extraction is anchored against the session baseline so startup pane noise does not leak into user-facing output
- Polls until agent finishes a task (`wait`) using a stricter completion heuristic that requires both visible answer content and the follow-up prompt returning, scoped to the last submitted prompt; when still running or timing out, it falls back to the live stream log instead of returning an empty/over-cleaned pane
- Runs one-shot non-interactive tasks via `agent -p` and returns output (`run`) — output is redirected to a tmpfile, user-facing output is cleaned, and raw CLIXML/progress noise is kept only in `rawOutput`
- Adds a task-oriented orchestration command (`task`) that compiles a natural-language goal plus options into a TaskSpec, chooses the best session policy automatically (reuse live → resume recent → fresh start), drives execution, tracks milestone-oriented task state, and synthesizes a dense final summary
- Lists past Cursor agent conversations via `agent ls` in a temporary tmux session (`history`) — returns structured list with UUIDs and titles, then resumes any of them by chat ID (`resume`)
- Resume supports an optional initial prompt in one command: `resume :: <chatId> :: <prompt>`
- `open` command is now an alias for `start` (starts agent session, does not open GUI)
- Returns `tmux attach-session` command for direct terminal access to a session (`attach`)
- Lists available AI models (`models`), switches model in a live session (`model`)
- Attaches `@path` context references to a live session (`context`)
- Shows current project rules (`rules`) and all available slash commands (`commands`)
- Triggers inline diff/review mode via Ctrl+R (`review`)
- Gracefully quits and cleans up a session (`quit`)
- Sends `/compress` to free up context window in a live session
- Manages MCP servers on the fly via `/mcp enable/disable`
- Authenticates via `agent login`, updates CLI via `agent update`
- Injects `CURSOR_API_KEY` from config into all agent commands automatically (masked in display/logs)
- Optionally installs a Cursor-only PowerShell `git` wrapper that forwards repo checks to WSL git, avoiding flaky Windows git detection in WSL→Windows agent sessions
- Reports bridge status, repo health, and active tmux sessions

## Concepts: tmux session vs agent conversation

These are two separate layers:

| | tmux session | Cursor agent conversation |
|---|---|---|
| What | Linux terminal process | Cursor's stored chat history |
| Lifecycle | Lives until `stop`/`quit` or reboot | Persists on disk across restarts |
| Created by | `/cursor start` | `agent` CLI on first prompt |
| Identified by | `cursor-<repo>` (tmux name) | chat ID (UUID, e.g. `2f89b160-...`) |
| Survives reboot | No | Yes |
| Listed by | `/cursor sessions` | `/cursor history <repo>` |

`/cursor resume` loads a past conversation's context into a new tmux session. The agent picks up where it left off. Chat IDs shown by `/cursor history` can be passed directly to `/cursor resume`.

## Why tmux-backed sessions

The Cursor `agent` CLI requires a real PTY. Running it directly from a subprocess, or passing it as a `tmux new-session` initial command (which runs detached without a TTY), causes it to exit immediately. This plugin works around that by:

1. Creating a bare tmux session (shell only)
2. Waiting for the shell to be ready (`startDelaySec`)
3. Sending the `agent` command as keystrokes via `send-keys` so it runs inside a real PTY
4. Waiting for agent UI to render (`trustDelaySec`)
5. Conditionally sending `a` to accept the workspace trust prompt (only if the pane shows a trust dialog)

The same pattern is used for `history` (runs `agent ls` in a temp tmux session), `login`, and `run`.

## Command reference

### Infrastructure

```text
/cursor status
```
Shows Cursor binary version, agent version, prereq health, all configured repos and whether their paths exist, active tmux sessions.

```text
/cursor repos
```
Lists whitelisted repo aliases and their resolved paths.

```text
/cursor sessions
```
Lists active tmux sessions managed by this plugin (filtered by `tmuxPrefix`).

```text
/cursor login
```
Runs `agent login` in a tmux session with a proper TTY. Check the output URL and authenticate in your browser. The session is kept alive for you to interact with if needed.

```text
/cursor update
```
Runs `agent update` to update the Cursor CLI to the latest version.

---

### Open / Start

```text
/cursor open <repo>
```
Alias for `start`. Starts a persistent tmux-backed `agent` session by cd-ing to the project directory and running the agent. Does **not** open the Cursor GUI.

---

### Interactive session lifecycle

```text
/cursor start <repo> [model=<model>]
```
Starts a persistent tmux-backed `agent` session for the repo. Internally:
1. Creates a bare tmux session with the repo as working directory
2. Waits `startDelaySec` for shell to be ready
3. Sends the agent command via `send-keys` so it runs inside a real PTY (WSL: injects `Set-Location <WindowsCwd>` into the PowerShell invocation)
4. Waits `trustDelaySec`, auto-accepts workspace trust if prompted

If a live session already exists, reuses it. If a dead session exists (tmux present but agent exited), kills it and restarts.

```text
/cursor start <repo> :: <initial-prompt> [model=<model>]
```
Same as above, but immediately sends `<initial-prompt>` to the agent after it starts. Useful for kicking off a task in a single command.

```text
/cursor send <repo> :: <instruction>
```
Sends the instruction text to the live agent session as keyboard input followed by Enter. The agent receives it as a prompt in the interactive UI.

```text
/cursor tail <repo> [lines]
```
Captures the last N lines (default 80, max 400) from the tmux pane and returns them. Use this to read agent output without waiting.

```text
/cursor wait <repo> [seconds]
```
Polls the tmux pane every 3 seconds until the agent stops showing busy indicators (`Working`, `Thinking`, spinner characters) for two consecutive polls, then returns the captured output. Times out gracefully. Default 120s, max 600s.

```text
/cursor stop <repo>
```
Kills the tmux session for the repo. The agent process is terminated. Cursor's stored conversation history is **not** deleted.

```text
/cursor quit <repo>
```
Gracefully exits the agent: sends Ctrl+C twice (interrupt any running task), then Ctrl+D twice (EOF/exit signal), then kills the tmux session. Cleaner than `stop` for a running agent.

---

### History and resume

```text
/cursor history <repo>
```
Runs `agent ls` in a temporary tmux session (so it has a proper PTY) and captures the list of past conversations with their chat IDs and summaries. The session is cleaned up automatically. Output includes UUIDs you can pass to `resume`.

```text
/cursor resume <repo>
```
Resumes the most recent Cursor agent conversation (`agent resume`). Creates a new tmux session, launches agent with the resume flag, accepts trust prompt. Pick up exactly where you left off.

```text
/cursor resume <repo> :: <chat-id> [model=<model>]
```
Resumes a specific conversation by chat ID (`agent --resume=<chat-id>`). Optionally override the model. If a live session exists, throws — stop it first.

```text
/cursor resume <repo> :: <chat-id> :: <initial-prompt> [model=<model>]
```
Same as above, but also sends `<initial-prompt>` immediately after the agent starts. Useful for resuming and kicking off the next task in one command.

**Typical workflow:**
```text
/cursor history workspace           ← get list of past conversations and their IDs
/cursor resume workspace :: 2f89b160-12d6-47b7-afcf-cca35a50bff6 :: 继续之前的任务
```

---

### One-shot tasks

```text
/cursor run <repo> :: <instruction> [model=<model>] [format=<text|json|stream-json>] [wait=<seconds>]
```
Runs a non-interactive `agent -p "<instruction>" --force` task in an ephemeral tmux session. Output is redirected to a tmpfile (not pane-captured), so structured JSON output is clean and free of TUI escape codes. Polls until the shell prompt returns, then reads the file, cleans up, and returns a cleaned `output` plus `rawOutput` for debugging.

- `model=` — override default model
- `format=json` — structured JSON output
- `format=stream-json` — also adds `--stream-partial-output` for streaming incremental JSON objects
- `wait=<seconds>` — max wait time (default 120s, max 600s)

### Task orchestration

```text
/cursor task <repo> :: <goal> [model=<model>] [mode=<auto|interactive|oneshot>] [resume=<auto|reuse-live|resume-recent|fresh>] [format=<text|json|stream-json>] [wait=<seconds>] [context=a,b] [deliverable=...]
```

`task` is the vNext entry point for larger, lower-communication work. Instead of relaying a single prompt, it compiles a natural-language goal plus options into a TaskSpec, picks the best execution policy, runs the work, and returns structured task state with a dense synthesized summary.

The synthesized summary is intentionally shaped like a short task report:
- Outcome
- Execution mode / policy
- Milestone progress
- Changes / findings
- Validation
- Risks / follow-ups

What it does:
- compiles the goal into assumptions, constraints, milestones, success criteria, and final deliverable expectations
- chooses a session strategy automatically by default: reuse live repo session → resume recent stored conversation → start fresh
- supports explicit overrides with `mode=` and `resume=`
- optionally attaches `@context` references before execution via `context=a,b,c`
- extracts milestone / validation / blocker / approval / risk signals from agent output so task state is more useful than a raw transcript
- for interactive tasks, if the first response stalls on a soft blocker or approval-style pause, it sends one follow-up continuation prompt to push the agent toward a concrete finish or concrete blocker
- returns task state including phase, milestone status, chosen policy, raw output, cleaned output, signals, and a concise task-report style summary

Suggested usage:
```text
/cursor task workspace :: fix the auth regression, run relevant tests, and summarize the result wait=300
/cursor task workspace :: audit the new API surface and return JSON findings mode=oneshot format=json
/cursor task workspace :: continue the refactor from earlier resume=resume-recent context=README.md,src/server
```

---

### Model management

```text
/cursor models <repo>
```
Runs `agent --list-models` (non-interactive) in the repo directory and returns all available model names. Does not require an active session.

```text
/cursor start <repo> model=<model-name>
```
Starts an agent session with a specific model via `--model` flag. If `defaultModel` is set in config, it is used when no `model=` flag is given.

```text
/cursor model <repo>
```
Sends `/models` to the live interactive session, opening the interactive model picker. Use keyboard to select.

```text
/cursor model <repo> :: <model-name>
```
Sends `/models` to the live interactive session, then types the model name and confirms. Best-effort — depends on the agent picker accepting the exact name as typed.

---

### Context and slash commands

```text
/cursor context <repo> :: <path>
```
Types `@<path>` followed by a space into the live agent input box, attaching the file or folder as a context reference. Does not submit — you can then add more text or send a follow-up.

```text
/cursor rules <repo>
```
Sends `/rules` Enter to the live session and captures the output. Shows the current project's Cursor rules.

```text
/cursor commands <repo>
```
Sends `/commands` Enter to the live session and captures the output. Lists all available slash commands supported by the running agent.

```text
/cursor review <repo>
```
Sends Ctrl+R to the live session, triggering inline diff/review mode.

```text
/cursor attach <repo>
```
Returns the `tmux attach-session` command for the repo's session. Does not execute it (that would require a TTY in your terminal). Run the returned command in your own terminal to watch or interact with the agent directly.

---

### Context window management

```text
/cursor compress <repo>
```
Sends `/compress` to the live interactive session. Summarises the conversation so far and frees up context window space. Does not start a new conversation.

---

### MCP server management

```text
/cursor mcp <repo> :: enable <server-name>
/cursor mcp <repo> :: disable <server-name>
```
Sends `/mcp enable <server>` or `/mcp disable <server>` to the live interactive session. Server names with spaces are supported.

---

## Example workflows

### First-time setup

```text
/cursor login                              ← authenticate with Cursor
/cursor update                             ← make sure CLI is up to date
/cursor status                             ← verify config and prereqs
```

### Standard interactive coding session

```text
/cursor start workspace
/cursor send workspace :: 分析这个项目并修复登录页按钮不显示的问题，直接改代码并在最后总结改动
/cursor wait workspace 180                 ← waits until agent finishes
/cursor tail workspace 200                 ← read the full output
```

### Start with immediate task

```text
/cursor start workspace :: 先看看项目结构，找出有 bug 的地方 model=sonnet-4.6
/cursor wait workspace 120
/cursor tail workspace 120
```

### Continue editing from last session

```text
/cursor history workspace                  ← find chat IDs from past conversations
/cursor resume workspace :: 2f89b160-12d6-47b7-afcf-cca35a50bff6
/cursor send workspace :: 继续刚才的任务，把登录页的样式也改一下
/cursor wait workspace 120
```

### Resume the most recent conversation

```text
/cursor resume workspace                   ← no chat-id needed, uses latest
/cursor send workspace :: 还有什么遗漏的地方吗？
/cursor wait workspace 60
```

### One-shot task (no persistent session)

```text
/cursor run workspace :: 运行所有测试并报告失败的用例
/cursor run workspace :: 查找 SQL 注入漏洞 format=json wait=300
```

### Switch model mid-session

```text
/cursor models workspace                   ← see available models
/cursor model workspace :: sonnet-4.6
/cursor send workspace :: 用新模型重新审查刚才的修改
```

### Attach context then send task

```text
/cursor context workspace :: src/components/Login.tsx
/cursor send workspace :: :: 看看这个组件有什么问题
```

### Check project rules and commands

```text
/cursor rules workspace                    ← show current Cursor rules
/cursor commands workspace                 ← list all slash commands
```

### Context window getting full

```text
/cursor compress workspace                 ← summarise and free context
/cursor send workspace :: 继续上面的任务
```

### Enable an MCP server for a session

```text
/cursor mcp workspace :: enable my-db-server
/cursor send workspace :: 查询用户表的结构
```

### Graceful exit

```text
/cursor quit workspace                     ← Ctrl+C x2, Ctrl+D x2, kill session
```

---

## Tool actions (for AI agents)

The `cursor_bridge` MCP/OpenClaw tool exposes all actions directly, usable by AI without human commands:

| Action | Required params | Optional params |
|--------|----------------|-----------------|
| `status` | — | — |
| `repos` | — | — |
| `sessions` | — | — |
| `open` | `repo` | — |
| `start` | `repo` | `model`, `initialPrompt` |
| `send` | `repo`, `text` | — |
| `tail` | `repo` | `lines` |
| `wait` | `repo` | `waitSec` |
| `stop` | `repo` | — |
| `quit` | `repo` | — |
| `attach` | `repo` | — |
| `history` | `repo` | — |
| `resume` | `repo` | `chatId`, `model`, `initialPrompt` |
| `models` | `repo` | — |
| `model` | `repo` | `model` (name to select) |
| `run` | `repo`, `text` | `model`, `outputFormat`, `waitSec` |
| `compress` | `repo` | — |
| `context` | `repo`, `contextPath` | — |
| `rules` | `repo` | — |
| `commands` | `repo` | — |
| `review` | `repo` | — |
| `mcp` | `repo`, `mcpAction`, `mcpServer` | — |
| `login` | — | — |
| `update` | — | — |

---

## Config reference

### Option A: Linux-native agent (simple)

```json
{
  "agentBinary": "agent",
  "allowAgent": true,
  "defaultModel": "sonnet-4.6",
  "repos": {
    "workspace": "/home/rog/.openclaw/workspace"
  }
}
```

### Option B: WSL → Windows agent via `agentWindowsBin` (recommended for WSL)

Set only the Windows binary path — the plugin auto-wraps it in `powershell.exe` with `Set-Location` injected for the correct project directory:

```json
{
  "agentWindowsBin": "C:\\Users\\rog\\AppData\\Local\\cursor-agent\\agent.cmd",
  "allowAgent": true,
  "defaultModel": "sonnet-4.6",
  "apiKey": "your-cursor-api-key",
  "repos": {
    "workspace": "/home/rog/.openclaw/workspace",
    "web_v1": "/mnt/e/voxa/web_v1",
    "web_v1:backend": "/mnt/e/voxa/web_v1"
  }
}
```

> For `web_v1:backend`, use the **base repo path** in `repos` and let the `:subdir` suffix do the resolution. You can also just use `web_v1:backend` directly in commands without pre-registering — it resolves as `repos.web_v1 + /backend`.

### Option C: WSL → Windows agent via `agentCommand` (manual, full control)

```json
{
  "agentCommand": "'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoLogo -NoProfile -Command \"& 'C:\\Users\\rog\\AppData\\Local\\cursor-agent\\agent.cmd'\"",
  "allowAgent": true,
  "repos": {
    "web_v1": "/mnt/e/voxa/web_v1"
  }
}
```

> With `agentCommand`, Set-Location is injected automatically when the command contains `powershell`.
>
> Local testing has now been migrated to `agentWindowsBin`; keep `agentCommand` mainly for manual/legacy setups.

### Full config reference table

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable/disable the whole plugin |
| `binary` | `cursor` | Path to Cursor binary (legacy, not used for agent operations) |
| `agentBinary` | `agent` | Agent binary name for Linux-native agent (used when `agentCommand` and `agentWindowsBin` are both empty) |
| `agentWindowsBin` | `""` | **WSL recommended.** Windows-side agent binary path (e.g. `C:\Users\...\agent.cmd`). Plugin auto-wraps with `powershell.exe -NoLogo -NoProfile -Command "Set-Location '<winCwd>'; $env:CURSOR_API_KEY=...; & '<bin>'"`. |
| `agentCommand` | `""` | Full shell command to launch agent. Overrides `agentBinary`. If it contains `powershell`, `Set-Location` is injected automatically. |
| `allowAgent` | `true` | Allow tmux-backed agent sessions and `-p` one-shot runs |
| `tmuxPrefix` | `cursor` | Prefix for tmux session names (`cursor-workspace`, etc.) |
| `timeoutSec` | `30` | Timeout in seconds for synchronous CLI calls |
| `startDelaySec` | `3` | Seconds to wait after creating tmux session before sending agent command |
| `trustDelaySec` | `3` | Seconds to wait after sending agent command before checking trust prompt |
| `defaultModel` | `sonnet-4.6` | Default model passed via `--model`. Overridable per-command with `model=<name>` |
| `apiKey` | `""` | Cursor API key (`CURSOR_API_KEY`). Injected into all agent commands. Masked in logs. |
| `repos` | `{}` | Map of `alias → absolute-linux-path`. Only listed repos can be used. Supports `alias:subdir` resolution at command time. |

---

## Self-test

Run a full smoke test against the first configured repo:

```bash
cd ~/.openclaw/extensions/cursor-bridge
npm run selftest
```

Or target a specific repo alias:

```bash
node ./selftest.mjs ~/.openclaw/openclaw.json web_v1
```

The `open` step (which now delegates to `startAgent`) is **skipped by default** to avoid spawning a live agent session during unattended smoke tests. Enable it explicitly:

```bash
CURSOR_BRIDGE_SELFTEST_OPEN=1 node ./selftest.mjs ~/.openclaw/openclaw.json web_v1
```

The self-test covers all commands and reports pass/fail per step as JSON.

---

## Troubleshooting

### Agent exits immediately after `start`

**Symptom:** `/cursor tail` shows a bare shell prompt, no agent UI.

**Cause:** The agent command is being run without a TTY, or the path is wrong.

**Fix:**
1. **WSL users (recommended):** Set `agentWindowsBin` to the Windows path of `agent.cmd` — the plugin handles the PowerShell wrapping and `Set-Location` automatically.
2. **Manual:** Check `agentCommand` — must be the full PowerShell path to `agent.cmd` on the Windows side.
3. Increase `startDelaySec` if the shell is slow to initialise.
4. Run `/cursor stop <repo>` then `/cursor start <repo>` to get a fresh session.

### Workspace trust prompt blocks the session

**Symptom:** Agent never responds, pane shows trust dialog.

**Fix:** Increase `trustDelaySec` so the plugin waits longer before checking for the trust prompt. Default is 3s. The plugin now only sends `a` if the trust dialog is actually detected.

### `history` returns empty or only shows a shell prompt

**Cause:** `agent ls` uses Ink TUI. Even inside a tmux session it may not render in time, or may not be supported by the installed agent version.

**Fix:** The plugin polls up to 6 seconds for UUID-formatted conversation IDs to appear. If it still shows nothing, try `/cursor resume workspace` (no ID) to resume the most recent conversation without needing a list.

### `send` goes to bash instead of agent

**Cause:** Agent exited but the tmux session is still alive.

**Fix:** `/cursor stop <repo>` then `/cursor start <repo>`. The `isAgentAlive()` check detects dead sessions and restarts cleanly.

### API key not being used

**Cause:** `apiKey` is empty in config, or `agentCommand` already includes its own auth mechanism.

**Fix:** Set `apiKey` in plugin config. It is injected as `CURSOR_API_KEY=<value>` before all agent commands, and masked as `***` in any log or display output.
