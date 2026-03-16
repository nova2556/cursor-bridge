import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  cleanOneShotOutput,
  cleanStreamText,
  extractLastAssistantAnswer,
  isMostlyUiChromeLine,
  normalizePane,
  paneLooksBusy,
  paneShowsInputPrompt,
  stripAnsi,
  stripCommandEchoNoise,
} from "./heuristics.ts";

const execFileAsync = promisify(execFile);
const TOOL_ACTIONS = ["status", "repos", "open", "start", "send", "tail", "stop", "sessions", "history", "resume", "models", "wait", "run", "task", "login", "update", "compress", "mcp", "model", "context", "rules", "commands", "review", "quit", "attach"] as const;
type ToolAction = (typeof TOOL_ACTIONS)[number];

type PluginConfig = {
  enabled?: boolean;
  binary?: string;
  agentBinary?: string;
  agentCommand?: string;
  agentWindowsBin?: string;
  timeoutSec?: number;
  allowAgent?: boolean;
  tmuxPrefix?: string;
  repos?: Record<string, string>;
  startDelaySec?: number;
  trustDelaySec?: number;
  defaultModel?: string;
  apiKey?: string;
  enableGitWrapper?: boolean;
  taskDefaultWaitSec?: number;
  taskRecentHistoryLimit?: number;
  taskResumeWindowHours?: number;
  taskMilestoneMax?: number;
  taskPreferInteractive?: boolean;
  hooks?: {
    preTaskPrompt?: string;
    postTaskPrompt?: string;
    assumptionsPrompt?: string;
  };
};

type RepoInfo = { key: string; cwd: string };

type SendState = {
  sentAt: number;
  prompt: string;
  submitMethod?: string;
};

const lastSendState = new Map<string, SendState>();
const sessionBaselines = new Map<string, string>();
const streamReadOffsets = new Map<string, number>();

type CommandLane = "stable-cli" | "interactive-emulated";
type CommandReliability = "high" | "medium" | "low";

function stableCliMeta(reliability: CommandReliability = "high") {
  return {
    lane: "stable-cli" as const,
    reliability,
    implementation: "cli/headless-oriented",
    heuristic: false,
  };
}

function interactiveMeta(reliability: CommandReliability = "medium") {
  return {
    lane: "interactive-emulated" as const,
    reliability,
    implementation: "tmux-pane-emulation",
    heuristic: true,
  };
}

type SessionInfo = {
  session: string;
  windows: string;
  created: string;
  createdEpoch?: number;
};

type TaskSpec = {
  goal: string;
  deliverable: string;
  mode: "interactive" | "oneshot" | "auto";
  model?: string;
  waitSec: number;
  outputFormat: "text" | "json" | "stream-json";
  resume: "auto" | "reuse-live" | "resume-recent" | "fresh";
  initialContextPaths: string[];
  assumptions: string[];
  constraints: string[];
  milestones: string[];
  successCriteria: string[];
  hooks: {
    preTaskPrompt?: string;
    postTaskPrompt?: string;
    assumptionsPrompt?: string;
  };
};

type TaskSessionDecision = {
  mode: "interactive" | "oneshot";
  policy: string;
  sessionStrategy: "reuse-live" | "resume-recent" | "fresh-start" | "oneshot";
  lane: "stable-cli" | "interactive-emulated";
  reliability: "high" | "medium" | "low";
  liveSession?: string;
  resumedChatId?: string;
  historyCount?: number;
};

type TaskSignalSeverity = "info" | "warning" | "blocking";

type TaskSignal = {
  kind: "milestone" | "validation" | "change" | "blocker" | "approval" | "risk";
  text: string;
  severity: TaskSignalSeverity;
};

type TaskState = {
  repo: string;
  session?: string;
  chatId?: string;
  mode: "interactive" | "oneshot";
  phase: "planning" | "running" | "synthesizing" | "done" | "timed_out";
  milestoneStatus: Array<{ title: string; status: "pending" | "inferred_done" | "blocked" }>;
  assumptions: string[];
  constraints: string[];
  successCriteria: string[];
  rawOutput: string;
  output: string;
  summary: string;
  signals: TaskSignal[];
  blockerSummary?: string;
  approvalSummary?: string;
  decision: TaskSessionDecision;
};

const CursorToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: [...TOOL_ACTIONS] },
    repo: { type: "string", description: "Whitelisted repo key from plugin config." },
    text: { type: "string", description: "Text/instruction to send or run." },
    lines: { type: "integer", minimum: 1, maximum: 400 },
    chatId: { type: "string", description: "Cursor agent chat/session ID to resume. Omit to resume most recent." },
    waitSec: { type: "integer", minimum: 1, maximum: 600, description: "Max seconds to wait for agent to become idle (wait/run actions)." },
    model: { type: "string", description: "Model name to use, e.g. gpt-5. Passed as --model to agent." },
    outputFormat: { type: "string", enum: ["text", "json", "stream-json"], description: "Output format for run action (--output-format)." },
    mcpAction: { type: "string", enum: ["enable", "disable"], description: "MCP server action (enable or disable)." },
    mcpServer: { type: "string", description: "MCP server name to enable or disable." },
    contextPath: { type: "string", description: "File or folder path to attach as @context reference in the agent conversation." },
    initialPrompt: { type: "string", description: "Initial instruction to send immediately after the agent starts (start action)." },
    goal: { type: "string", description: "High-level task goal for task action." },
    mode: { type: "string", enum: ["auto", "interactive", "oneshot"], description: "Task execution mode." },
    resume: { type: "string", enum: ["auto", "reuse-live", "resume-recent", "fresh"], description: "Task session selection policy." },
    contextPaths: { type: "array", items: { type: "string" }, description: "Optional @context paths to attach before task execution." },
    deliverable: { type: "string", description: "Explicit deliverable expectations for task action." },
  },
} as const;

export function normalizeConfig(raw: unknown): Required<PluginConfig> {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as PluginConfig) : {};
  return {
    enabled: cfg.enabled ?? true,
    binary: (cfg.binary ?? "cursor").trim() || "cursor",
    agentBinary: (cfg.agentBinary ?? "agent").trim() || "agent",
    agentCommand: (cfg.agentCommand ?? "").trim(),
    agentWindowsBin: (cfg.agentWindowsBin ?? "").trim(),
    timeoutSec: Number.isFinite(cfg.timeoutSec) ? Math.max(5, Math.min(7200, Number(cfg.timeoutSec))) : 30,
    allowAgent: cfg.allowAgent ?? true,
    tmuxPrefix: (cfg.tmuxPrefix ?? "cursor").trim() || "cursor",
    repos: cfg.repos ?? {},
    startDelaySec: Number.isFinite(cfg.startDelaySec) ? Math.max(1, Math.min(30, Number(cfg.startDelaySec))) : 3,
    trustDelaySec: Number.isFinite(cfg.trustDelaySec) ? Math.max(1, Math.min(30, Number(cfg.trustDelaySec))) : 3,
    defaultModel: (cfg.defaultModel ?? "sonnet-4.6").trim(),
    apiKey: (cfg.apiKey ?? "").trim(),
    enableGitWrapper: cfg.enableGitWrapper ?? true,
    taskDefaultWaitSec: Number.isFinite(cfg.taskDefaultWaitSec) ? Math.max(30, Math.min(1800, Number(cfg.taskDefaultWaitSec))) : 240,
    taskRecentHistoryLimit: Number.isFinite(cfg.taskRecentHistoryLimit) ? Math.max(1, Math.min(20, Number(cfg.taskRecentHistoryLimit))) : 6,
    taskResumeWindowHours: Number.isFinite(cfg.taskResumeWindowHours) ? Math.max(1, Math.min(168, Number(cfg.taskResumeWindowHours))) : 24,
    taskMilestoneMax: Number.isFinite(cfg.taskMilestoneMax) ? Math.max(3, Math.min(12, Number(cfg.taskMilestoneMax))) : 6,
    taskPreferInteractive: cfg.taskPreferInteractive ?? false,
    hooks: {
      preTaskPrompt: cfg.hooks?.preTaskPrompt?.trim() || "",
      postTaskPrompt: cfg.hooks?.postTaskPrompt?.trim() || "",
      assumptionsPrompt: cfg.hooks?.assumptionsPrompt?.trim() || "",
    },
  };
}

function shellSplit(input: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function streamRootDir(): string {
  return path.join(tmpdir(), "openclaw-cursor-bridge-streams");
}

function streamLogPath(session: string): string {
  return path.join(streamRootDir(), `${session}.log`);
}

async function ensureStreamRoot(): Promise<void> {
  await mkdir(streamRootDir(), { recursive: true });
}

async function resetStreamCapture(session: string): Promise<string> {
  await ensureStreamRoot();
  const logPath = streamLogPath(session);
  await rm(logPath, { force: true }).catch(() => {});
  await writeFile(logPath, "", "utf8");
  streamReadOffsets.set(session, 0);
  return logPath;
}

async function startStreamCapture(session: string): Promise<string> {
  const logPath = await resetStreamCapture(session);
  const pipeCommand = `cat >> ${quoteSh(logPath)}`;
  await runTmux(["pipe-pane", "-o", "-t", `${session}:0.0`, pipeCommand], 10);
  return logPath;
}

async function stopStreamCapture(session: string): Promise<void> {
  await runTmux(["pipe-pane", "-t", `${session}:0.0`], 10).catch(() => {});
}

async function readStreamLog(session: string): Promise<string> {
  const logPath = streamLogPath(session);
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return "";
  }
}

async function readStreamDelta(session: string, reset = false): Promise<{ delta: string; offset: number; logPath: string }> {
  const logPath = streamLogPath(session);
  const raw = await readStreamLog(session);
  const prior = reset ? 0 : (streamReadOffsets.get(session) ?? 0);
  const safePrior = Math.max(0, Math.min(prior, raw.length));
  const delta = raw.slice(safePrior);
  streamReadOffsets.set(session, raw.length);
  return { delta: cleanStreamText(delta), offset: raw.length, logPath };
}

async function markStreamOffset(session: string): Promise<number> {
  const raw = await readStreamLog(session);
  streamReadOffsets.set(session, raw.length);
  return raw.length;
}

async function peekStreamTail(session: string, maxChars = 12000): Promise<{ text: string; logPath: string; bytes: number }> {
  const logPath = streamLogPath(session);
  const raw = await readStreamLog(session);
  const slice = raw.length > maxChars ? raw.slice(raw.length - maxChars) : raw;
  return { text: cleanStreamText(slice), logPath, bytes: raw.length };
}

function preferStreamOutput(streamText: string, paneText: string, busy: boolean): string {
  const cleanStream = cleanStreamText(streamText);
  const cleanPane = cleanStreamText(paneText);
  if (busy && cleanStream) return cleanStream;
  return cleanPane || cleanStream;
}




type ParsedInlineOptions = {
  model?: string;
  outputFormat?: "text" | "json" | "stream-json";
  waitSec?: number;
  mode?: "auto" | "interactive" | "oneshot";
  resume?: "auto" | "reuse-live" | "resume-recent" | "fresh";
  contextPaths?: string[];
  deliverable?: string;
  remainder: string;
};

function isRecognizedInlineOptionToken(token: string): boolean {
  return /^(model|format|wait|mode|resume|context|deliverable)=/i.test(token.trim());
}

function parseTrailingInlineOptions(input: string, allowed: Array<"model" | "format" | "wait" | "mode" | "resume" | "context" | "deliverable">): ParsedInlineOptions {
  const allowedSet = new Set(allowed);
  let working = input.trim();
  const out: ParsedInlineOptions = { remainder: working };

  if (allowedSet.has("deliverable")) {
    const deliverableMatch = working.match(/(?:^|\s)deliverable=(.+)$/);
    if (deliverableMatch) {
      out.deliverable = deliverableMatch[1].trim();
      working = working.slice(0, deliverableMatch.index).trim();
    }
  }

  const tokens = shellSplit(working);
  if (!tokens.length) {
    out.remainder = working;
    return out;
  }

  let i = tokens.length - 1;
  while (i >= 0) {
    const token = tokens[i].trim();
    if (!token) {
      i -= 1;
      continue;
    }

    const match = token.match(/^(\w+)=(.+)$/);
    if (!match) break;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (!allowedSet.has(key as any)) break;

    if (key === "model") out.model = value;
    else if (key === "format" && /^(text|json|stream-json)$/.test(value)) out.outputFormat = value as ParsedInlineOptions["outputFormat"];
    else if (key === "wait" && /^\d+$/.test(value)) out.waitSec = Number(value);
    else if (key === "mode" && /^(auto|interactive|oneshot)$/.test(value)) out.mode = value as ParsedInlineOptions["mode"];
    else if (key === "resume" && /^(auto|reuse-live|resume-recent|fresh)$/.test(value)) out.resume = value as ParsedInlineOptions["resume"];
    else if (key === "context") out.contextPaths = value.split(",").map((item) => item.trim()).filter(Boolean);
    else break;

    tokens.splice(i, 1);
    i = tokens.length - 1;
  }

  out.remainder = tokens.join(" ").trim();
  return out;
}
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function buildWindowsGitWrapperEnv(gitWrapperWindowsPath: string | null): string {
  if (!gitWrapperWindowsPath) return "";
  return `$env:OPENCLAW_CURSOR_GIT_WRAPPER=${quotePsh(gitWrapperWindowsPath)}; $env:PATH=${quotePsh(`${getGitWrapperBinWindowsDir()};`)} + $env:PATH; `;
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function trimBlock(text: string, max = 12000): string {
  const clean = (text || "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n\n...[truncated ${clean.length - max} chars]`;
}

async function capturePane(session: string, lines = 160): Promise<string> {
  const depth = Math.max(20, Math.min(800, Math.floor(lines)));
  const { stdout } = await runTmux(["capture-pane", "-t", session, "-p", "-S", `-${depth}`], 15).catch(() => ({ stdout: "" }));
  return normalizePane(stdout);
}


function trimToSessionBaseline(session: string, pane: string): string {
  const baseline = sessionBaselines.get(session);
  if (!baseline) return pane;
  const idx = pane.lastIndexOf(baseline);
  if (idx === -1) return pane;
  return pane.slice(idx + baseline.length).trimStart();
}

function trimToLastSendContext(session: string, pane: string): string {
  const baselineTrimmed = trimToSessionBaseline(session, pane);
  const state = lastSendState.get(session);
  if (!state) return baselineTrimmed;
  const normalizedPrompt = normalizePane(state.prompt).trim();
  if (!normalizedPrompt) return baselineTrimmed;
  const idx = baselineTrimmed.lastIndexOf(normalizedPrompt);
  if (idx !== -1) return baselineTrimmed.slice(idx + normalizedPrompt.length).trimStart();

  const lines = baselineTrimmed.split(/\r?\n/);
  const promptLines = normalizedPrompt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const marker = promptLines[promptLines.length - 1];
  if (!marker) return baselineTrimmed;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes(marker)) {
      return lines.slice(i + 1).join("\n").trimStart();
    }
  }
  return baselineTrimmed;
}

// Resolve a repo key to its filesystem path.
// Supports "repo" (exact key) and "repo:subdir" (subproject syntax).
// Example: "web_v1:backend" resolves to `${repos.web_v1}/backend`.
function resolveRepo(config: Required<PluginConfig>, repo: string): RepoInfo {
  const trimmed = repo.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx !== -1) {
    const baseKey = trimmed.slice(0, colonIdx);
    const subdir = trimmed.slice(colonIdx + 1);
    const baseCwd = config.repos[baseKey];
    if (!baseCwd) {
      throw new Error(`Unknown repo: ${baseKey}. Allowed repos: ${Object.keys(config.repos).sort().join(", ") || "(none)"}`);
    }
    const cwd = path.resolve(path.join(baseCwd, subdir));
    // Use the full "repo:subdir" string as the key for display + session naming (with colon replaced)
    return { key: trimmed.replace(/[^a-zA-Z0-9_-]+/g, "-"), cwd };
  }
  const cwd = config.repos[trimmed];
  if (!cwd) {
    throw new Error(`Unknown repo: ${trimmed}. Allowed repos: ${Object.keys(config.repos).sort().join(", ") || "(none)"}`);
  }
  return { key: trimmed, cwd: path.resolve(cwd) };
}

function tmuxSessionName(config: Required<PluginConfig>, repo: string): string {
  return `${config.tmuxPrefix}-${repo.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

export async function runQuick(binary: string, args: string[], cwd: string, timeoutSec: number, apiKey?: string) {
  const { stdout, stderr } = await execFileAsync(binary, args, {
    cwd,
    timeout: timeoutSec * 1000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, CI: process.env.CI ?? "1", ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}) },
  });
  return { stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
}

export async function runShell(command: string, cwd: string, timeoutSec: number, apiKey?: string) {
  const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", command], {
    cwd,
    timeout: timeoutSec * 1000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, CI: process.env.CI ?? "1", ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}) },
  });
  return { stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
}

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Quote a value for use inside a PowerShell -Command string (single-quoted).
function quotePsh(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function getWindowsPowerShellPath(): string {
  return "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
}

function getGitWrapperWindowsPath(): string {
  return "C:\\Users\\rog\\AppData\\Local\\Temp\\openclaw-cursor-git\\cursor_git_wrapper.ps1";
}

function getGitWrapperCmdWindowsPath(): string {
  return "C:\\Users\\rog\\AppData\\Local\\Temp\\openclaw-cursor-git\\git.cmd";
}

function getGitWrapperBinWindowsDir(): string {
  return "C:\\Users\\rog\\AppData\\Local\\Temp\\openclaw-cursor-git";
}

async function ensureGitWrapper(config: Required<PluginConfig>): Promise<string | null> {
  if (!config.enableGitWrapper) return null;
  const dirLinux = "/mnt/c/Users/rog/AppData/Local/Temp/openclaw-cursor-git";
  const psLinux = `${dirLinux}/cursor_git_wrapper.ps1`;
  const cmdLinux = `${dirLinux}/git.cmd`;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dirLinux, { recursive: true });
  const psContent = `param(\n  [Parameter(ValueFromRemainingArguments = $true)]\n  [string[]]$ArgsFromCaller\n)\n$bash = 'C:\\Windows\\System32\\bash.exe'\nif (-not (Test-Path $bash)) { $bash = 'C:\\Windows\\System32\\wsl.exe' }\nif (-not (Test-Path $bash)) {\n  Write-Error 'No bash.exe or wsl.exe found'\n  exit 127\n}\n$mapped = @()\nfor ($i = 0; $i -lt $ArgsFromCaller.Count; $i++) {\n  $arg = $ArgsFromCaller[$i]\n  if ($arg -eq '-C' -and $i + 1 -lt $ArgsFromCaller.Count) {\n    $mapped += '-C'\n    $i += 1\n    $p = $ArgsFromCaller[$i]\n    if ($p -match '^[A-Za-z]:\\\\') {\n      $drive = $p.Substring(0,1).ToLower()\n      $rest = ($p.Substring(2) -replace '\\\\','/')\n      if (-not $rest.StartsWith('/')) { $rest = '/' + $rest }\n      $mapped += "/mnt/$drive$rest"\n    } else {\n      $mapped += $p\n    }\n    continue\n  }\n  $mapped += $arg\n}\n$escaped = ($mapped | ForEach-Object { "'" + ($_ -replace "'", "'\\''") + "'" }) -join ' '\n$cmd = "git $escaped"\n& $bash -lc $cmd\nexit $LASTEXITCODE\n`;
  const cmdContent = `@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${getGitWrapperWindowsPath()}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
  await writeFile(psLinux, psContent, "utf8");
  await writeFile(cmdLinux, cmdContent, "utf8");
  return getGitWrapperWindowsPath();
}

// Convert a WSL Linux path to a Windows path.
// /mnt/e/voxa/web_v1  →  E:\voxa\web_v1
// /mnt/c/Users/rog    →  C:\Users\rog
// Paths not starting with /mnt/ are returned unchanged.
export function linuxToWindowsPath(linuxPath: string): string {
  const match = linuxPath.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
  if (!match) return linuxPath;
  const driveLetter = match[1].toUpperCase();
  const rest = (match[2] ?? "").replace(/\//g, "\\");
  return `${driveLetter}:${rest}`;
}

// Build the full agent launch command with optional cd-to-cwd injection.
// When running on WSL against a Windows-side agent:
//   - If agentWindowsBin is set: generate a full powershell.exe -Command invocation with Set-Location
//   - If agentCommand contains powershell: inject Set-Location before the & call
//   - Otherwise: rely on tmux -c cwd (Linux-native agent)
function buildAgentLaunch(
  config: Required<PluginConfig>,
  cwd: string,
  model?: string,
  gitWrapperWindowsPath?: string | null,
  extraAgentArgs = "",
): { command: string; display: string } {
  const effectiveModel = model || config.defaultModel;
  const modelFlag = effectiveModel ? ` --model ${quoteSh(effectiveModel)}` : "";
  const modelFlagPsh = effectiveModel ? ` --model ${quotePsh(effectiveModel)}` : "";
  const defaultAgentFlags = " --force --approve-mcps";
  const extraAgentArgsPsh = extraAgentArgs || "";
  const apiKeyEnvBash = config.apiKey ? `CURSOR_API_KEY=${quoteSh(config.apiKey)} ` : "";
  const apiKeyEnvPsh = config.apiKey ? `$env:CURSOR_API_KEY=${quotePsh(config.apiKey)}; ` : "";
  const gitWrapperEnvPsh = buildWindowsGitWrapperEnv(gitWrapperWindowsPath ?? null);
  const windowsCwd = linuxToWindowsPath(cwd);
  const needsCd = windowsCwd !== cwd; // only inject Set-Location when path was actually converted

  // ── Case 1: agentWindowsBin set — generate clean PowerShell invocation ──────
  if (config.agentWindowsBin) {
    const bin = config.agentWindowsBin;
    const cdPart = needsCd ? `Set-Location ${quotePsh(windowsCwd)}; ` : "";
    const inner = `${apiKeyEnvPsh}${gitWrapperEnvPsh}${cdPart}& ${quotePsh(bin)}${modelFlagPsh}${defaultAgentFlags}${extraAgentArgsPsh}`;
    const encoded = encodePowerShellCommand(inner);
    const ps = quoteSh(getWindowsPowerShellPath());
    const command = `${ps} -NoLogo -NoProfile -EncodedCommand ${quoteSh(encoded)}`;
    const displayInner = `${config.apiKey ? "$env:CURSOR_API_KEY=***; " : ""}${gitWrapperWindowsPath ? "$env:OPENCLAW_CURSOR_GIT_WRAPPER='***'; $env:PATH='***;' + $env:PATH; " : ""}${cdPart}& ${quotePsh(bin)}${modelFlagPsh}${defaultAgentFlags}${extraAgentArgsPsh}`;
    const display = `${ps} -NoLogo -NoProfile -EncodedCommand <base64:${trimBlock(displayInner, 240)}>`;
    return { command, display };
  }

  // ── Case 2: agentCommand contains powershell — inject Set-Location into it ──
  if (config.agentCommand && /powershell/i.test(config.agentCommand)) {
    // Extract the -Command "..." content and prepend Set-Location + apiKey env
    const cdPart = needsCd ? `Set-Location ${quotePsh(windowsCwd)}; ` : "";
    // Replace the opening -Command " with -Command "Set-Location ...; apiKey...; originalContent
    const injected = config.agentCommand.replace(
      /(-Command\s+")([^]*)/i,
      (_m, prefix, rest) => `${prefix}${apiKeyEnvPsh}${gitWrapperEnvPsh}${cdPart}${rest}`,
    );
    const command = injected + modelFlag + defaultAgentFlags + extraAgentArgs;
    const display = command.replace(config.apiKey ? quoteSh(config.apiKey) : "NEVER_MATCH", "***");
    return { command, display };
  }

  // ── Case 3: Linux-native agent (agentBinary or non-powershell agentCommand) ─
  const base = config.agentCommand ? config.agentCommand : quoteSh(config.agentBinary);
  const command = `${apiKeyEnvBash}${base}${modelFlag}${defaultAgentFlags}${extraAgentArgs}`;
  const display = config.apiKey ? `CURSOR_API_KEY=*** ${base}${modelFlag}${defaultAgentFlags}${extraAgentArgs}` : `${base}${modelFlag}${defaultAgentFlags}${extraAgentArgs}`;
  return { command, display };
}

export async function runTmux(args: string[], timeoutSec = 15, apiKey?: string) {
  const { stdout, stderr } = await execFileAsync("tmux", args, {
    timeout: timeoutSec * 1000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, CI: process.env.CI ?? "1", ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}) },
  });
  return { stdout: stdout || "", stderr: stderr || "" };
}

export async function checkPrereqs(config: Required<PluginConfig>) {
  const problems: string[] = [];
  try {
    await runTmux(["-V"], 10);
  } catch {
    problems.push("tmux is not available in PATH");
  }
  try {
    await runQuick(config.binary, ["--version"], process.cwd(), Math.min(config.timeoutSec, 15), config.apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(`Cursor binary not runnable: ${message}`);
  }
  if (config.allowAgent) {
    try {
      if (config.agentWindowsBin) {
        const ps = getWindowsPowerShellPath();
        const inner = `${config.apiKey ? `$env:CURSOR_API_KEY=${quotePsh(config.apiKey)}; ` : ""}& ${quotePsh(config.agentWindowsBin)} --version`;
        await runQuick(ps, ["-NoLogo", "-NoProfile", "-Command", inner], process.cwd(), Math.min(config.timeoutSec, 15), config.apiKey);
      } else if (config.agentCommand) {
        await runShell(`${config.agentCommand} --version`, process.cwd(), Math.min(config.timeoutSec, 15), config.apiKey);
      } else {
        await runQuick(config.agentBinary, ["--version"], process.cwd(), Math.min(config.timeoutSec, 15), config.apiKey);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems.push(`Agent command not runnable: ${message}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    await runTmux(["has-session", "-t", name], 10);
    return true;
  } catch {
    return false;
  }
}

export async function listSessions(config: Required<PluginConfig>): Promise<SessionInfo[]> {
  const { stdout } = await runTmux(["list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_created_string}\t#{session_created}"], 10).catch(() => ({ stdout: "", stderr: "" }));
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [session = "", windows = "", created = "", createdEpochRaw = ""] = line.split("\t");
      const createdEpoch = Number(createdEpochRaw);
      return { session, windows, created, createdEpoch: Number.isFinite(createdEpoch) ? createdEpoch : undefined };
    })
    .filter((row) => row.session.startsWith(`${config.tmuxPrefix}-`));
}

// Open a repo by starting an agent session. This is an alias for startAgent,
// keeping the "open" command available for users who prefer that verb.
export async function openRepo(config: Required<PluginConfig>, repo: string) {
  return startAgent(config, repo);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TRANSIENT_AGENT_ERROR_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ECONNABORTED/i,
  /ETIMEDOUT/i,
  /ESOCKETTIMEDOUT/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /EPIPE/i,
  /socket hang up/i,
  /socket error/i,
  /network error/i,
  /network request failed/i,
  /fetch failed/i,
  /TLS/i,
  /SSL/i,
  /certificate/i,
  /Client network socket disconnected/i,
  /temporary failure in name resolution/i,
  /getaddrinfo\s+(?:EAI_AGAIN|ENOTFOUND)/i,
  /unexpected EOF/i,
  /connection .*reset/i,
] as const;

export function isTransientAgentError(text: string): boolean {
  const sample = text || "";
  return TRANSIENT_AGENT_ERROR_PATTERNS.some((pattern) => pattern.test(sample));
}

async function captureRecentPane(session: string, lines = 160): Promise<string> {
  const { stdout } = await runTmux(["capture-pane", "-t", session, "-p", "-S", `-${Math.max(20, Math.min(800, Math.floor(lines)))}`], 15).catch(() => ({ stdout: "" }));
  return stdout || "";
}

async function maybeRetryAgentLaunch<T>(
  kind: "start" | "resume" | "run",
  session: string,
  attempt: number,
  launch: () => Promise<T>,
): Promise<T> {
  try {
    return await launch();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const pane = session ? await captureRecentPane(session, 220).catch(() => "") : "";
    const combined = `${message}\n${pane}`;
    const shouldRetry = attempt < 2 && isTransientAgentError(combined);
    if (!shouldRetry) throw err;
    if (session) {
      await stopStreamCapture(session).catch(() => {});
      await runTmux(["kill-session", "-t", session], 10).catch(() => {});
      lastSendState.delete(session);
      sessionBaselines.delete(session);
      streamReadOffsets.delete(session);
      await rm(streamLogPath(session), { force: true }).catch(() => {});
    }
    await sleep(1200 * attempt);
    return launch();
  }
}

// Probe whether the agent process is alive by checking recent pane output.
// Heuristics: if the pane shows a bare shell prompt with no agent UI markers,
// the agent has exited and we're back to raw bash.
export async function isAgentAlive(session: string): Promise<boolean> {
  try {
    const { stdout } = await runTmux(["capture-pane", "-t", session, "-p", "-S", "-20"], 10);
    const text = stdout.trim();
    if (!text) return false;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? "";
    const looksLikeShellPrompt = /[$%#>]\s*$/.test(lastLine);
    // Use specific Cursor agent UI markers only — avoid generic words like "cursor" or "agent"
    // that can appear in shell prompts, file paths, or command names.
    const hasAgentMarker =
      text.includes("●") ||
      text.includes("◆") ||
      text.includes("Working") ||
      text.includes("Thinking") ||
      // Spinner characters used by Ink TUI
      /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text) ||
      // Cursor agent prompt area typically shows the model name in parentheses or brackets
      /claude|gpt-|sonnet|opus|haiku|gemini/i.test(text) ||
      // Agent input prompt line ("> " with nothing before it on the last line)
      /^>\s/.test(lastLine);
    if (looksLikeShellPrompt && !hasAgentMarker) return false;
    return true;
  } catch {
    return false;
  }
}

export async function startAgent(config: Required<PluginConfig>, repo: string, model?: string, initialPrompt?: string) {
  if (!config.enabled) throw new Error("cursor-bridge is disabled in plugin config");
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const { key, cwd } = resolveRepo(config, repo);
  if (!(await pathExists(cwd))) throw new Error(`Configured repo path does not exist: ${cwd}`);
  const session = tmuxSessionName(config, key);
  const gitWrapperWindowsPath = await ensureGitWrapper(config);

  if (await tmuxSessionExists(session)) {
    if (await isAgentAlive(session)) {
      return { action: "start" as const, repo: key, cwd, session, reused: true };
    }
    await runTmux(["kill-session", "-t", session], 10);
  }

  const launch = buildAgentLaunch(config, cwd, model, gitWrapperWindowsPath);
  const launchOnce = async () => {
    await runTmux(["new-session", "-d", "-s", session, "-c", cwd], 20);
    await startStreamCapture(session);
    await sleep(config.startDelaySec * 1000);
    await runTmux(["send-keys", "-t", session, "-l", "--", launch.command], 10);
    await runTmux(["send-keys", "-t", session, "Enter"], 10);
    await sleep(config.trustDelaySec * 1000);

    const trustProbe = await runTmux(["capture-pane", "-t", session, "-p", "-S", "-80"], 10).catch(() => ({ stdout: "" }));
    if (/trust workspace|trust this workspace|workspace trust|press a to trust/i.test(trustProbe.stdout)) {
      await runTmux(["send-keys", "-t", session, "a"], 10);
      await sleep(800);
    }

    if (!(await isAgentAlive(session))) {
      const pane = await runTmux(["capture-pane", "-t", session, "-p", "-S", "-120"], 10).catch(() => ({ stdout: "" }));
      throw new Error(`Agent failed to stay alive after start. Recent pane output:\n${trimBlock(pane.stdout, 3000) || "(no output)"}`);
    }

    const baselinePane = await capturePane(session, 220).catch(() => "");
    sessionBaselines.set(session, baselinePane);
    lastSendState.delete(session);

    if (initialPrompt) {
      await sendToAgent(config, key, initialPrompt);
    }

    return { action: "start" as const, repo: key, cwd, session, reused: false, launch: launch.display };
  };

  return maybeRetryAgentLaunch("start", session, 1, launchOnce);
}

export async function sendToAgent(config: Required<PluginConfig>, repo: string, text: string) {
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const { key } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  if (!(await tmuxSessionExists(session))) {
    throw new Error(`No active Cursor session for ${key}. Start one with /cursor start ${key}`);
  }
  if (!(await isAgentAlive(session))) {
    throw new Error(`Agent in session ${session} appears to have exited. Restart with /cursor start ${key}`);
  }

  const before = await capturePane(session, 120);
  const submitAttempts: string[] = [];
  const submitMethods: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "literal+Enter",
      run: async () => {
        await runTmux(["send-keys", "-t", session, "-l", "--", text], 10);
        await sleep(120);
        await runTmux(["send-keys", "-t", session, "Enter"], 10);
      },
    },
    {
      name: "literal+C-m",
      run: async () => {
        await runTmux(["send-keys", "-t", session, "-l", "--", text], 10);
        await sleep(120);
        await runTmux(["send-keys", "-t", session, "C-m"], 10);
      },
    },
    {
      name: "paste-buffer+Enter",
      run: async () => {
        const bufferName = `cursor-send-${Date.now()}`;
        await runTmux(["set-buffer", "-b", bufferName, "--", text], 10);
        await runTmux(["paste-buffer", "-t", session, "-b", bufferName], 10);
        await sleep(120);
        await runTmux(["send-keys", "-t", session, "Enter"], 10);
        await runTmux(["delete-buffer", "-b", bufferName], 10).catch(() => {});
      },
    },
  ];

  for (let i = 0; i < submitMethods.length; i += 1) {
    const method = submitMethods[i];
    await method.run();
    submitAttempts.push(method.name);
    await sleep(700);
    const after = await capturePane(session, 120);
    const changed = after.trim() !== before.trim();
    const busy = paneLooksBusy(after);
    const promptVisible = paneShowsInputPrompt(after);
    const answerBlock = extractLastAssistantAnswer(after);
    const likelyAccepted = changed && (busy || (!promptVisible && answerBlock.length > 0));
    if (likelyAccepted) {
        await markStreamOffset(session);
      lastSendState.set(session, { sentAt: Date.now(), prompt: text, submitMethod: method.name });
      return { action: "send" as const, repo: key, session, sent: text, submitMethod: method.name, ...interactiveMeta("medium") };
    }
    if (i < submitMethods.length - 1) {
      await runTmux(["send-keys", "-t", session, "C-u"], 10).catch(() => {});
      await sleep(150);
    }
  }

  const finalPane = await capturePane(session, 160);
  throw new Error(`Prompt may not have been accepted by Cursor agent. Tried ${submitAttempts.join(", ")}. Recent pane output:\n${trimBlock(finalPane, 4000) || "(no output)"}`);
}

export async function tailAgent(config: Required<PluginConfig>, repo: string, lines = 80) {
  const { key } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  if (!(await tmuxSessionExists(session))) {
    throw new Error(`No active Cursor session for ${key}. Start one with /cursor start ${key}`);
  }
  const pane = await capturePane(session, Math.max(1, Math.min(400, lines)));
  const scopedPane = trimToLastSendContext(session, pane);
  const busy = paneLooksBusy(pane);
  const answer = extractLastAssistantAnswer(scopedPane);
  const streamTail = await peekStreamTail(session, 16000);
  const streamDelta = await readStreamDelta(session);
  const liveOutput = preferStreamOutput(streamDelta.delta || streamTail.text, scopedPane || pane, busy);
  return {
    action: "tail" as const,
    repo: key,
    session,
    lines: Math.max(1, Math.min(400, lines)),
    busy,
    output: trimBlock((busy ? liveOutput : (answer || liveOutput || scopedPane || pane)), 16000),
    rawOutput: trimBlock(streamTail.text || scopedPane || pane, 16000),
    liveOutput: trimBlock(streamDelta.delta || "", 12000),
    logPath: streamTail.logPath,
    streamBytes: streamTail.bytes,
    ...interactiveMeta("medium"),
  };
}

export async function stopAgent(config: Required<PluginConfig>, repo: string) {
  const { key } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  if (!(await tmuxSessionExists(session))) {
    lastSendState.delete(session);
    sessionBaselines.delete(session);
    streamReadOffsets.delete(session);
    await rm(streamLogPath(session), { force: true }).catch(() => {});
    return { action: "stop" as const, repo: key, session, stopped: false };
  }
  await stopStreamCapture(session);
  await runTmux(["kill-session", "-t", session], 10);
  lastSendState.delete(session);
  sessionBaselines.delete(session);
  streamReadOffsets.delete(session);
  await rm(streamLogPath(session), { force: true }).catch(() => {});
  return { action: "stop" as const, repo: key, session, stopped: true };
}

// Parse raw `agent ls` pane output into structured conversation entries.
// Expected line format (may vary by agent version):
//   2f89b160-12d6-47b7-afcf-cca35a50bff6  分析下这个项目  2026-03-09
// Returns an empty array if no UUIDs are found.
function parseHistoryOutput(raw: string): Array<{ id: string; title: string; raw: string }> {
  const entries: Array<{ id: string; title: string; raw: string }> = [];
  const uuidPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(uuidPattern);
    if (!match) continue;
    const id = match[1];
    // Title is everything after the UUID, strip leading/trailing whitespace and control chars.
    const title = line.slice(line.indexOf(id) + id.length).replace(/\s+/g, " ").trim() || "(no title)";
    entries.push({ id, title, raw: line.trim() });
  }
  return entries;
}

// List Cursor agent conversation history via `agent ls`.
// `agent ls` requires a real TTY (it uses Ink TUI), so we spawn it inside a
// temporary tmux session, wait for it to render, capture the pane, then clean up.
// Returns both structured entries (for programmatic use) and raw text (for display).
export async function listHistory(config: Required<PluginConfig>, cwd: string) {
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const lsSession = `${config.tmuxPrefix}-ls-${Date.now()}`;
  const gitWrapperWindowsPath = await ensureGitWrapper(config);
  const launch = buildAgentLaunch(config, cwd, undefined, gitWrapperWindowsPath, " ls");
  const lsCommand = launch.command;
  try {
    await runTmux(["new-session", "-d", "-s", lsSession, "-c", cwd], 20);
    await sleep(config.startDelaySec * 1000);
    await runTmux(["send-keys", "-t", lsSession, "-l", "--", lsCommand], 10);
    await runTmux(["send-keys", "-t", lsSession, "Enter"], 10);
    // `agent ls` renders immediately — poll up to 6 s for the list to appear.
    let output = "";
    for (let i = 0; i < 6; i++) {
      await sleep(1000);
      const { stdout } = await runTmux(["capture-pane", "-t", lsSession, "-p", "-S", "-60"], 10).catch(() => ({ stdout: "" }));
      output = stdout;
      // Stop polling once we see conversation IDs (UUID-like strings) or an "empty" message.
      if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(output) || /no conversations|empty|no chats/i.test(output)) break;
    }
    const entries = parseHistoryOutput(output);
    return { action: "history" as const, entries, output: trimBlock(output, 12000), ...interactiveMeta("low") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: "history" as const, entries: [], output: `(agent ls failed: ${message})`, ...interactiveMeta("low") };
  } finally {
    await runTmux(["kill-session", "-t", lsSession], 10).catch(() => {});
  }
}

// Resume a previous Cursor agent conversation by chat ID, launching it inside tmux.
// Pass empty chatId to resume the most recent conversation (`agent resume`).
// The resumed session replaces any existing dead session for the repo.
export async function resumeAgent(config: Required<PluginConfig>, repo: string, chatId: string, model?: string, initialPrompt?: string) {
  if (!config.enabled) throw new Error("cursor-bridge is disabled in plugin config");
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const { key, cwd } = resolveRepo(config, repo);
  if (!(await pathExists(cwd))) throw new Error(`Configured repo path does not exist: ${cwd}`);
  const session = tmuxSessionName(config, key);
  const gitWrapperWindowsPath = await ensureGitWrapper(config);

  if (await tmuxSessionExists(session)) {
    if (await isAgentAlive(session)) {
      throw new Error(`Session ${session} already has a live agent. Stop it first with /cursor stop ${key}`);
    }
    await runTmux(["kill-session", "-t", session], 10);
  }

  const resumeArgs = chatId
    ? ` --resume=${quotePsh(chatId)}`
    : " resume";
  const launch = buildAgentLaunch(config, cwd, model, gitWrapperWindowsPath, resumeArgs);
  const effectiveModel = model || config.defaultModel;
  const resumeCommand = launch.command;

  const launchOnce = async () => {
    await runTmux(["new-session", "-d", "-s", session, "-c", cwd], 20);
    await startStreamCapture(session);
    await sleep(config.startDelaySec * 1000);
    await runTmux(["send-keys", "-t", session, "-l", "--", resumeCommand], 10);
    await runTmux(["send-keys", "-t", session, "Enter"], 10);
    await sleep(config.trustDelaySec * 1000);
    const trustProbe = await runTmux(["capture-pane", "-t", session, "-p", "-S", "-80"], 10).catch(() => ({ stdout: "" }));
    if (/trust workspace|trust this workspace|workspace trust|press a to trust/i.test(trustProbe.stdout)) {
      await runTmux(["send-keys", "-t", session, "a"], 10);
      await sleep(800);
    }
    if (!(await isAgentAlive(session))) {
      const pane = await runTmux(["capture-pane", "-t", session, "-p", "-S", "-120"], 10).catch(() => ({ stdout: "" }));
      throw new Error(`Agent failed to stay alive after resume. Recent pane output:\n${trimBlock(pane.stdout, 3000) || "(no output)"}`);
    }

    const baselinePane = await capturePane(session, 220).catch(() => "");
    sessionBaselines.set(session, baselinePane);
    lastSendState.delete(session);

    if (initialPrompt) {
      await sendToAgent(config, key, initialPrompt);
    }

    return { action: "resume" as const, repo: key, cwd, session, chatId: chatId || "(most recent)", model: effectiveModel || "(default)", launch: launch.display };
  };

  return maybeRetryAgentLaunch("resume", session, 1, launchOnce);
}

// List available models via `agent --list-models`.
export async function listModels(config: Required<PluginConfig>, cwd: string) {
  try {
    if (config.agentWindowsBin) {
      const ps = getWindowsPowerShellPath();
      const windowsCwd = linuxToWindowsPath(cwd);
      const inner = `${config.apiKey ? `$env:CURSOR_API_KEY=${quotePsh(config.apiKey)}; ` : ""}${windowsCwd !== cwd ? `Set-Location ${quotePsh(windowsCwd)}; ` : ""}& ${quotePsh(config.agentWindowsBin)} --list-models`;
      const { stdout, stderr } = await runQuick(ps, ["-NoLogo", "-NoProfile", "-Command", inner], cwd, config.timeoutSec, config.apiKey);
      return { action: "models" as const, output: trimBlock(stdout || stderr, 12000), ...stableCliMeta("high") };
    }
    const command = config.agentCommand
      ? `${config.agentCommand} --list-models`
      : `${quoteSh(config.agentBinary)} --list-models`;
    const { stdout, stderr } = await runShell(command, cwd, config.timeoutSec, config.apiKey);
    return { action: "models" as const, output: trimBlock(stdout || stderr, 12000), ...stableCliMeta("high") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: "models" as const, output: `(agent --list-models failed: ${message})`, ...stableCliMeta("high") };
  }
}

// Poll tmux pane until agent returns to an idle state (blank prompt) or timeout.
// Returns the captured output when done, or times out gracefully.
export async function waitForAgent(config: Required<PluginConfig>, repo: string, waitSec = 120) {
  const { key, session } = await requireInteractiveSession(config, repo);
  const deadline = Date.now() + Math.max(5, Math.min(600, waitSec)) * 1000;
  const pollMs = 3000;
  let lastSnapshot: InteractiveSnapshot | null = null;
  let lastLive = "";
  let idleRounds = 0;
  let completed = false;
  let sawBusy = false;
  let sawAnswer = false;
  let stableAnswerRounds = 0;
  let quietLiveRounds = 0;
  let previousAnswer = "";
  let previousLive = "";
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const snapshot = await captureInteractiveSnapshot(session, 220);
    lastSnapshot = snapshot;
    const liveDelta = snapshot.streamDelta || "";
    if (liveDelta) lastLive = liveDelta;
    const liveStable = !liveDelta || liveDelta === previousLive;
    previousLive = liveDelta;
    if (snapshot.busy) {
      sawBusy = true;
      idleRounds = 0;
      quietLiveRounds = 0;
      stableAnswerRounds = 0;
      previousAnswer = snapshot.answer;
      continue;
    }
    if (snapshot.answerVisible) {
      sawAnswer = true;
      if (snapshot.answer === previousAnswer) stableAnswerRounds += 1;
      else stableAnswerRounds = 1;
      previousAnswer = snapshot.answer;
    }
    if (liveStable) quietLiveRounds += 1;
    else quietLiveRounds = 0;
    if (!sawBusy && !sawAnswer && !lastLive) {
      continue;
    }
    if (!snapshot.promptVisible && !snapshot.answerVisible && !liveStable) {
      idleRounds = 0;
      continue;
    }
    idleRounds += 1;
    const answerSettled = sawAnswer && stableAnswerRounds >= 2;
    const streamSettled = !!lastLive && quietLiveRounds >= 2;
    if (idleRounds >= 2 && ((snapshot.promptVisible && (sawAnswer || streamSettled)) || answerSettled || (streamSettled && !snapshot.busy))) {
      completed = true;
      break;
    }
  }
  const timedOut = !completed;
  const finalSnapshot = lastSnapshot ? {
    ...lastSnapshot,
    ...(await captureInteractiveSnapshot(session, 220, true)),
  } : await captureInteractiveSnapshot(session, 220, true);
  const output = buildInteractiveOutput({
    ...finalSnapshot,
    streamDelta: timedOut ? (lastLive || finalSnapshot.streamDelta) : (finalSnapshot.answer || lastLive ? (lastLive || finalSnapshot.streamDelta) : finalSnapshot.streamDelta),
  });
  const preferredOutput = timedOut
    ? trimBlock(lastLive || finalSnapshot.streamTailText || finalSnapshot.scopedPane || finalSnapshot.pane, 16000)
    : trimBlock(finalSnapshot.answer || lastLive || finalSnapshot.streamTailText || finalSnapshot.scopedPane || finalSnapshot.pane, 16000);
  return interactiveResult({
    action: "wait" as const,
    repo: key,
    session,
    timedOut,
    output: preferredOutput,
    rawOutput: output.rawOutput,
    liveOutput: output.liveOutput,
    logPath: output.logPath,
    streamBytes: output.streamBytes,
    completionHeuristics: {
      sawBusy,
      sawAnswer,
      stableAnswerRounds,
      idleRounds,
      quietLiveRounds,
    },
  }, "medium");
}

// Run a one-shot non-interactive agent task via `agent -p "..."`.
// Spawns in a fresh tmux window, waits for completion, captures output, then cleans up.
export async function runOneShot(
  config: Required<PluginConfig>,
  repo: string,
  text: string,
  waitSec = 120,
  model?: string,
  outputFormat: "text" | "json" | "stream-json" = "text",
) {
  if (!config.enabled) throw new Error("cursor-bridge is disabled in plugin config");
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const { key, cwd } = resolveRepo(config, repo);
  if (!(await pathExists(cwd))) throw new Error(`Configured repo path does not exist: ${cwd}`);

  const baseSession = tmuxSessionName(config, key);
  const gitWrapperWindowsPath = await ensureGitWrapper(config);
  const formatFlag = ` --output-format ${outputFormat}`;
  const streamFlag = outputFormat === "stream-json" ? " --stream-partial-output" : "";
  const extraArgs = ` -p ${quotePsh(text)}${formatFlag}${streamFlag} --force`;
  const launch = buildAgentLaunch(config, cwd, model, gitWrapperWindowsPath, extraArgs);

  const runOnce = async (attempt: number) => {
    const runSession = `${baseSession}-run-${Date.now()}-${attempt}`;
    const tmpFile = path.join(tmpdir(), `cursor-run-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
    const oneShotCommand = `${launch.command} > ${quoteSh(tmpFile)} 2>&1`;

    try {
      await runTmux(["new-session", "-d", "-s", runSession, "-c", cwd], 20);
      await sleep(config.startDelaySec * 1000);
      await runTmux(["send-keys", "-t", runSession, "-l", "--", oneShotCommand], 10);
      await runTmux(["send-keys", "-t", runSession, "Enter"], 10);

      const deadline = Date.now() + Math.max(10, Math.min(600, waitSec)) * 1000;
      const pollMs = 3000;
      let idleRounds = 0;
      let completed = false;
      const donePattern = /[$%#>]\s*$/m;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        const { stdout: pane } = await runTmux(["capture-pane", "-t", runSession, "-p", "-S", "-10"], 10).catch(() => ({ stdout: "" }));
        if (donePattern.test(pane)) {
          idleRounds += 1;
          if (idleRounds >= 2) { completed = true; break; }
        } else {
          idleRounds = 0;
        }
      }

      const timedOut = !completed;
      let output = "";
      try {
        output = await readFile(tmpFile, "utf8");
      } catch {
        const { stdout: pane } = await runTmux(["capture-pane", "-t", runSession, "-p", "-S", "-200"], 10).catch(() => ({ stdout: "" }));
        output = pane;
      }

      if ((timedOut || !cleanOneShotOutput(output)) && attempt < 2 && isTransientAgentError(output)) {
        throw new Error(`Transient one-shot agent failure detected:\n${trimBlock(output, 3000)}`);
      }

      const cleanedOutput = cleanOneShotOutput(output);
      return {
        action: "run" as const,
        repo: key,
        cwd,
        prompt: text,
        timedOut,
        output: trimBlock(cleanedOutput || output, 16000),
        rawOutput: trimBlock(output, 16000),
        ...stableCliMeta("high"),
      };
    } finally {
      await unlink(tmpFile).catch(() => {});
      await runTmux(["kill-session", "-t", runSession], 10).catch(() => {});
    }
  };

  return maybeRetryAgentLaunch("run", `${baseSession}-run`, 1, async () => runOnce(1)).catch(async (firstErr) => {
    if (!isTransientAgentError(firstErr instanceof Error ? firstErr.message : String(firstErr))) throw firstErr;
    await sleep(1200);
    return runOnce(2);
  });
}

// Run `agent login` to authenticate Cursor CLI via browser or API key flow.
// Spawns a dedicated tmux session so the interactive login flow has a proper TTY.
export async function loginAgent(config: Required<PluginConfig>) {
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const loginSession = `${config.tmuxPrefix}-login-${Date.now()}`;
  const base = config.agentCommand ? config.agentCommand : quoteSh(config.agentBinary);
  const envPrefix = config.apiKey ? `CURSOR_API_KEY=${quoteSh(config.apiKey)} ` : "";
  const loginCommand = `${envPrefix}${base} login`;
  await runTmux(["new-session", "-d", "-s", loginSession], 20);
  await sleep(config.startDelaySec * 1000);
  await runTmux(["send-keys", "-t", loginSession, "-l", "--", loginCommand], 10);
  await runTmux(["send-keys", "-t", loginSession, "Enter"], 10);
  // Give browser redirect a moment to open, then capture the pane for any URL/instructions.
  await sleep(4000);
  const { stdout } = await runTmux(["capture-pane", "-t", loginSession, "-p", "-S", "-30"], 10).catch(() => ({ stdout: "" }));
  return { action: "login" as const, session: loginSession, output: trimBlock(stdout, 4000) };
}

// Run `agent update` (or `agent upgrade`) to update the Cursor CLI to the latest version.
export async function updateAgent(config: Required<PluginConfig>) {
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const base = config.agentCommand ? config.agentCommand : quoteSh(config.agentBinary);
  const updateCommand = `${base} update`;
  try {
    const { stdout, stderr } = await runShell(updateCommand, process.cwd(), Math.max(config.timeoutSec, 60), config.apiKey);
    return { action: "update" as const, output: trimBlock(stdout || stderr, 8000) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: "update" as const, output: `(agent update failed: ${message})` };
  }
}

// Send the /compress slash command to a live interactive agent session to summarise
// the conversation and free up context window space.
export async function compressSession(config: Required<PluginConfig>, repo: string) {
  const { key } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  if (!(await tmuxSessionExists(session))) {
    throw new Error(`No active Cursor session for ${key}. Start one with /cursor start ${key}`);
  }
  if (!(await isAgentAlive(session))) {
    throw new Error(`Agent in session ${session} appears to have exited. Restart with /cursor start ${key}`);
  }
  await runTmux(["send-keys", "-t", session, "/compress", "Enter"], 10);
  return { action: "compress" as const, repo: key, session };
}

// Send `/mcp enable <server>` or `/mcp disable <server>` to a live interactive agent session.
export async function mcpControl(config: Required<PluginConfig>, repo: string, mcpAction: "enable" | "disable", mcpServer: string) {
  const { key } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  if (!(await tmuxSessionExists(session))) {
    throw new Error(`No active Cursor session for ${key}. Start one with /cursor start ${key}`);
  }
  if (!(await isAgentAlive(session))) {
    throw new Error(`Agent in session ${session} appears to have exited. Restart with /cursor start ${key}`);
  }
  const slashCmd = `/mcp ${mcpAction} ${mcpServer}`;
  await runTmux(["send-keys", "-t", session, slashCmd, "Enter"], 10);
  return { action: "mcp" as const, repo: key, session, mcpAction, mcpServer };
}

// Switch the model in a live interactive agent session by sending the `/models` slash command.
// With no modelName, just opens the interactive model picker.
// With a modelName, sends `/models` then types the name and confirms — best-effort since the
// picker UI is text-based and may require exact matching.
export async function switchModel(config: Required<PluginConfig>, repo: string, modelName?: string) {
  const { key } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  if (!(await tmuxSessionExists(session))) {
    throw new Error(`No active Cursor session for ${key}. Start one with /cursor start ${key}`);
  }
  if (!(await isAgentAlive(session))) {
    throw new Error(`Agent in session ${session} appears to have exited. Restart with /cursor start ${key}`);
  }
  // Send the /models slash command to open the model picker.
  await runTmux(["send-keys", "-t", session, "/models", "Enter"], 10);
  if (modelName) {
    // Wait briefly for the picker to render, then type the model name to filter/select it.
    await sleep(800);
    await runTmux(["send-keys", "-t", session, "-l", "--", modelName], 10);
    await sleep(400);
    await runTmux(["send-keys", "-t", session, "Enter", ""], 10);
  }
  return { action: "model" as const, repo: key, session, modelName: modelName || "(picker opened)" };
}

// Add @<path> file/folder context reference to the current agent conversation.
// Cursor agent supports `@path` syntax to attach context.
export async function addContext(config: Required<PluginConfig>, repo: string, contextPath: string) {
  const { key } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  if (!(await tmuxSessionExists(session))) {
    throw new Error(`No active Cursor session for ${key}. Start one with /cursor start ${key}`);
  }
  if (!(await isAgentAlive(session))) {
    throw new Error(`Agent in session ${session} appears to have exited. Restart with /cursor start ${key}`);
  }
  const ref = contextPath.startsWith("@") ? contextPath : `@${contextPath}`;
  await runTmux(["send-keys", "-t", session, "-l", "--", ref], 10);
  await sleep(300);
  // Press space so the agent registers the context reference without submitting yet.
  await runTmux(["send-keys", "-t", session, " "], 10);
  return { action: "context" as const, repo: key, session, contextPath: ref };
}

// Send the /rules slash command to display current project rules inside the agent session.
function hasMeaningfulSlashCommandOutput(text: string, slashCommand: string): boolean {
  const cleaned = stripCommandEchoNoise(cleanStreamText(text || ""));
  if (!cleaned) return false;
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  if (lines.length === 1 && lines[0] === slashCommand) return false;
  return lines.some((line) => line !== slashCommand && !/^[|\\/\-\s]+$/.test(line));
}

async function captureSlashCommandOutput(session: string, slashCommand: "/rules" | "/commands", lines: number): Promise<string> {
  let best = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await sleep(500);
    const streamDelta = await readStreamDelta(session);
    const { stdout } = await runTmux(["capture-pane", "-t", session, "-p", "-S", `-${lines}`], 10).catch(() => ({ stdout: "" }));
    const raw = normalizePane(streamDelta.delta || stdout || "");
    const markerIdx = raw.lastIndexOf(slashCommand);
    const scoped = markerIdx === -1 ? normalizePane(streamDelta.delta || "") : raw.slice(markerIdx + slashCommand.length);
    const candidate = stripCommandEchoNoise(cleanStreamText(scoped) || scoped).trim();
    if (candidate.length > best.length) best = candidate;
    if (hasMeaningfulSlashCommandOutput(candidate, slashCommand)) return candidate;
  }
  return best;
}

export async function showRules(config: Required<PluginConfig>, repo: string) {
  const { key, session } = await requireInteractiveSession(config, repo);
  await runInteractiveSlashCommand(session, "/rules");
  const cleaned = await captureSlashCommandOutput(session, "/rules", 60);
  return interactiveResult({ action: "rules" as const, repo: key, session, output: trimBlock(cleaned, 8000) }, "low");
}

// Send the /commands slash command to list available slash commands.
export async function showCommands(config: Required<PluginConfig>, repo: string) {
  const { key } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  if (!(await tmuxSessionExists(session))) {
    throw new Error(`No active Cursor session for ${key}. Start one with /cursor start ${key}`);
  }
  if (!(await isAgentAlive(session))) {
    throw new Error(`Agent in session ${session} appears to have exited. Restart with /cursor start ${key}`);
  }
  await markStreamOffset(session);
  await runTmux(["send-keys", "-t", session, "/commands", "Enter"], 10);
  const cleaned = await captureSlashCommandOutput(session, "/commands", 70);
  return { action: "commands" as const, repo: key, session, output: trimBlock(cleaned, 8000), ...interactiveMeta("low") };
}

// Send Ctrl+R to trigger inline review / diff review inside the agent session.
export async function reviewSession(config: Required<PluginConfig>, repo: string) {
  const { key, session } = await requireInteractiveSession(config, repo);
  await runTmux(["send-keys", "-t", session, "C-r"], 10);
  return interactiveResult({ action: "review" as const, repo: key, session }, "low");
}

// Gracefully quit the agent session: send Ctrl+C twice to interrupt any running task,
// then Ctrl+D twice to signal EOF / exit the agent, then kill the tmux session.
export async function quitSession(config: Required<PluginConfig>, repo: string) {
  const { key } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  if (!(await tmuxSessionExists(session))) {
    streamReadOffsets.delete(session);
    await rm(streamLogPath(session), { force: true }).catch(() => {});
    return { action: "quit" as const, repo: key, session, stopped: false };
  }
  // Interrupt any running task.
  await runTmux(["send-keys", "-t", session, "C-c"], 10).catch(() => {});
  await sleep(300);
  await runTmux(["send-keys", "-t", session, "C-c"], 10).catch(() => {});
  await sleep(300);
  // Send EOF to ask agent to exit gracefully.
  await runTmux(["send-keys", "-t", session, "C-d"], 10).catch(() => {});
  await sleep(500);
  await runTmux(["send-keys", "-t", session, "C-d"], 10).catch(() => {});
  await sleep(800);
  await stopStreamCapture(session);
  // Force-kill the session to ensure cleanup.
  await runTmux(["kill-session", "-t", session], 10).catch(() => {});
  lastSendState.delete(session);
  sessionBaselines.delete(session);
  streamReadOffsets.delete(session);
  await rm(streamLogPath(session), { force: true }).catch(() => {});
  return { action: "quit" as const, repo: key, session, stopped: true };
}

// Return the tmux attach-session command for a repo session, so the user can run it
// in their own terminal to watch or interact with the agent directly.
// This does NOT execute tmux attach (which would block the plugin process and require a TTY);
// it just returns the command string and confirms the session exists.
export async function attachSession(config: Required<PluginConfig>, repo: string) {
  const { key } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  const exists = await tmuxSessionExists(session);
  const alive = exists ? await isAgentAlive(session) : false;
  const command = `tmux attach-session -t ${session}`;
  return { action: "attach" as const, repo: key, session, exists, alive, command };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values.map((v) => v.trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function inferTaskMilestones(goal: string, maxCount: number): string[] {
  const normalized = goal.toLowerCase();
  const milestones = [
    "Understand the repository context and relevant files",
    "Plan the concrete implementation or investigation steps",
  ];
  if (/(fix|implement|build|refactor|edit|change|write|code)/i.test(normalized)) milestones.push("Apply the required code or content changes");
  if (/(test|verify|validate|check|selftest|smoke)/i.test(normalized)) milestones.push("Run validation and capture results");
  milestones.push("Summarize outcome, risks, and next steps");
  return uniqueStrings(milestones).slice(0, maxCount);
}

export function compileTaskSpec(config: Required<PluginConfig>, goal: string, options?: Partial<TaskSpec> & { contextPaths?: string[]; deliverable?: string }): TaskSpec {
  const cleanGoal = goal.trim();
  if (!cleanGoal) throw new Error("goal is required for task execution");
  const outputFormat = options?.outputFormat ?? (/\bjson\b/i.test(options?.deliverable || "") ? "json" : "text");
  const mode = options?.mode ?? (outputFormat === "stream-json" ? "oneshot" : "auto");
  const waitSec = Math.max(30, Math.min(1800, options?.waitSec ?? config.taskDefaultWaitSec));
  const milestones = uniqueStrings(options?.milestones ?? inferTaskMilestones(cleanGoal, config.taskMilestoneMax)).slice(0, config.taskMilestoneMax);
  const deliverable = options?.deliverable?.trim() || (outputFormat === "json" ? "Return a structured result with concise findings, actions taken, and final status." : "Return a concise, high-density final summary with concrete results.");
  const assumptions = uniqueStrings([
    ...(options?.assumptions ?? []),
    "Avoid unnecessary back-and-forth; proceed with reasonable assumptions and call them out explicitly.",
  ]);
  const constraints = uniqueStrings([
    ...(options?.constraints ?? []),
    "Keep the final answer dense, concrete, and implementation-focused.",
    "Preserve backward compatibility unless the task explicitly says otherwise.",
  ]);
  const successCriteria = uniqueStrings(options?.successCriteria ?? [
    "Task goal is completed or driven to a concrete blocker.",
    "Key changes, validations, and remaining risks are clearly summarized.",
  ]);
  return {
    goal: cleanGoal,
    deliverable,
    mode,
    model: options?.model,
    waitSec,
    outputFormat,
    resume: options?.resume ?? "auto",
    initialContextPaths: uniqueStrings(options?.contextPaths ?? options?.initialContextPaths ?? []),
    assumptions,
    constraints,
    milestones,
    successCriteria,
    hooks: {
      preTaskPrompt: options?.hooks?.preTaskPrompt ?? config.hooks.preTaskPrompt,
      postTaskPrompt: options?.hooks?.postTaskPrompt ?? config.hooks.postTaskPrompt,
      assumptionsPrompt: options?.hooks?.assumptionsPrompt ?? config.hooks.assumptionsPrompt,
    },
  };
}

function buildTaskPrompt(spec: TaskSpec): string {
  const parts = [
    `Task goal: ${spec.goal}`,
    `Deliverable: ${spec.deliverable}`,
    spec.assumptions.length ? `Operating assumptions:\n${spec.assumptions.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}` : "",
    spec.constraints.length ? `Constraints:\n${spec.constraints.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}` : "",
    spec.milestones.length ? `Milestones to work through:\n${spec.milestones.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}` : "",
    spec.successCriteria.length ? `Success criteria:\n${spec.successCriteria.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}` : "",
    spec.hooks.assumptionsPrompt ? `Additional task assumptions prompt: ${spec.hooks.assumptionsPrompt}` : "",
    "Execution style: work autonomously, make pragmatic decisions, and report progress by milestone rather than constant chatter.",
    "Final response format:\n- Outcome\n- Milestones\n- Changes / findings\n- Validation\n- Risks / follow-ups",
  ].filter(Boolean);
  if (spec.hooks.preTaskPrompt) parts.unshift(spec.hooks.preTaskPrompt);
  if (spec.hooks.postTaskPrompt) parts.push(spec.hooks.postTaskPrompt);
  return parts.join("\n\n");
}

async function chooseTaskSession(config: Required<PluginConfig>, repo: string, spec: TaskSpec): Promise<TaskSessionDecision> {
  if (spec.mode === "oneshot") {
    return {
      mode: "oneshot",
      policy: "explicit oneshot mode",
      sessionStrategy: "oneshot",
      lane: "stable-cli",
      reliability: "high",
    };
  }
  if (spec.mode === "interactive") {
    const { key, cwd } = resolveRepo(config, repo);
    const session = tmuxSessionName(config, key);
    if ((spec.resume === "auto" || spec.resume === "reuse-live") && await tmuxSessionExists(session) && await isAgentAlive(session)) {
      return {
        mode: "interactive",
        policy: "explicit interactive mode reused live session for continuity",
        sessionStrategy: "reuse-live",
        lane: "interactive-emulated",
        reliability: "medium",
        liveSession: session,
      };
    }
    if (spec.resume !== "fresh") {
      const history = await listHistory(config, cwd).catch(() => ({ entries: [], output: "" }));
      const recentEntries = history.entries.slice(0, config.taskRecentHistoryLimit);
      if (recentEntries.length && (spec.resume === "auto" || spec.resume === "resume-recent")) {
        return {
          mode: "interactive",
          policy: `explicit interactive mode resumed recent stored conversation (${recentEntries[0]?.id ?? "latest"})`,
          sessionStrategy: "resume-recent",
          lane: "interactive-emulated",
          reliability: "medium",
          resumedChatId: recentEntries[0]?.id,
          historyCount: recentEntries.length,
        };
      }
    }
    return {
      mode: "interactive",
      policy: "explicit interactive mode started a fresh interactive session",
      sessionStrategy: "fresh-start",
      lane: "interactive-emulated",
      reliability: "medium",
    };
  }

  if (!config.taskPreferInteractive) {
    return {
      mode: "oneshot",
      policy: "auto mode prefers stable one-shot CLI execution",
      sessionStrategy: "oneshot",
      lane: "stable-cli",
      reliability: "high",
    };
  }

  const { key, cwd } = resolveRepo(config, repo);
  const session = tmuxSessionName(config, key);
  if ((spec.resume === "auto" || spec.resume === "reuse-live") && await tmuxSessionExists(session) && await isAgentAlive(session)) {
    return {
      mode: "interactive",
      policy: "auto mode reused live session for continuity",
      sessionStrategy: "reuse-live",
      lane: "interactive-emulated",
      reliability: "medium",
      liveSession: session,
    };
  }
  if (spec.resume !== "fresh") {
    const history = await listHistory(config, cwd).catch(() => ({ entries: [], output: "" }));
    const recentEntries = history.entries.slice(0, config.taskRecentHistoryLimit);
    if (recentEntries.length && (spec.resume === "auto" || spec.resume === "resume-recent")) {
      return {
        mode: "interactive",
        policy: `auto mode resumed recent stored conversation (${recentEntries[0]?.id ?? "latest"})`,
        sessionStrategy: "resume-recent",
        lane: "interactive-emulated",
        reliability: "medium",
        resumedChatId: recentEntries[0]?.id,
        historyCount: recentEntries.length,
      };
    }
  }
  return {
    mode: "interactive",
    policy: "auto mode started a fresh interactive session",
    sessionStrategy: "fresh-start",
    lane: "interactive-emulated",
    reliability: "medium",
  };
}

function taskOutputLines(output: string): string[] {
  return uniqueStrings(
    (output || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isMostlyUiChromeLine(line))
      .filter((line) => !/^[-=|]{3,}$/.test(line))
      .filter((line) => !/^Goal:/i.test(line)),
  );
}

export function collectTaskSignals(output: string): TaskSignal[] {
  const signals: TaskSignal[] = [];
  for (const line of taskOutputLines(output)) {
    const lower = line.toLowerCase();
    const clean = line.replace(/^[-*•\d.)\s]+/, "").trim();
    if (!clean) continue;
    const push = (kind: TaskSignal["kind"], severity: TaskSignalSeverity = "info") => {
      signals.push({ kind, severity, text: clean });
    };
    if (/\b(blocker|blocked|cannot continue|can't continue|unable to continue|stuck|failed because|waiting on|needs (approval|sign-off|confirmation|input)|requires (approval|sign-off|confirmation|input))\b/i.test(lower)) {
      const explicitBlocker = /^(blocker|blocked)\b/i.test(clean) || /\b(cannot continue|can't continue|unable to continue|stuck|failed because)\b/i.test(lower);
      const approvalOnly = !explicitBlocker && /\bapproval|sign-off|confirmation\b/i.test(lower);
      push(approvalOnly ? "approval" : "blocker", explicitBlocker ? "blocking" : "warning");
      continue;
    }
    if (/^(milestone|step|phase)\b/i.test(clean) || /\b(done|completed|finished|implemented|updated|validated|verified|tested|shipped)\b/i.test(lower)) {
      push("milestone");
      continue;
    }
    if (/\b(test|tests|validated|validation|verified|verify|selftest|smoke|lint|build|passed|pass|failing|failed)\b/i.test(lower)) {
      push("validation", /\b(fail|failed|failing|error)\b/i.test(lower) ? "warning" : "info");
      continue;
    }
    if (/\b(changed|updated|edited|modified|created|added|removed|refactored|implemented|wrote)\b/i.test(lower)) {
      push("change");
      continue;
    }
    if (/\b(risk|follow-up|follow up|todo|remaining|next step|next steps|caveat)\b/i.test(lower)) {
      push("risk", /\b(risk|caveat|remaining)\b/i.test(lower) ? "warning" : "info");
    }
  }
  return uniqueStrings(signals.map((item) => `${item.kind}|${item.severity}|${item.text}`)).map((key) => {
    const [kind, severity, ...rest] = key.split("|");
    return { kind: kind as TaskSignal["kind"], severity: severity as TaskSignalSeverity, text: rest.join("|") };
  });
}

function findTaskSummaryLine(lines: string[], pattern: RegExp): string | undefined {
  return lines.find((line) => pattern.test(line));
}

function normalizeTaskInteractiveOutput(raw: string): string {
  const filtered = taskOutputLines(stripCommandEchoNoise(raw || "")).filter((line) => {
    const lower = line.toLowerCase();
    if (!line.trim()) return false;
    if (/encodedcommand|powershell\.exe|\[pasted text|add a follow-up|ctrl\+c to stop|update-motd/.test(lower)) return false;
    if (/^(generating|running|reading)\b/.test(lower)) return false;
    if (/^plan, search, build anything\b/.test(lower)) return false;
    if (/^[A-Za-z0-9+/']{8,}={0,2}$/.test(line.trim())) return false;
    return true;
  });
  const joined = filtered.join("\n").trim();
  const last = filtered.at(-1)?.trim() || "";
  if (last && !/[:：]$/.test(last) && !/^(Outcome|Milestones|Changes|Validation|Risks|Evidence|Gaps|Final verdict)\b/i.test(last)) {
    return last;
  }
  return joined;
}

export function inferMilestoneStatus(milestones: string[], output: string): Array<{ title: string; status: "pending" | "inferred_done" | "blocked" }> {
  return milestones.map((title) => {
    const keywords = uniqueStrings(title.toLowerCase().split(/[^a-z0-9]+/i).filter((token) => token.length > 3)).slice(0, 4);
    const matchingLines = taskOutputLines(output).filter((line) => keywords.some((token) => line.toLowerCase().includes(token)));
    const blocked = matchingLines.some((line) => /\b(blocked|blocker|waiting on|cannot continue|can't continue|needs approval|requires approval)\b/i.test(line));
    const done = matchingLines.some((line) => /\b(done|completed|finished|implemented|updated|validated|verified|tested|created|wrote|fixed)\b/i.test(line));
    return { title, status: blocked ? "blocked" : done ? "inferred_done" : "pending" };
  });
}

async function maybeAdvanceInteractiveTask(config: Required<PluginConfig>, repo: string, spec: TaskSpec, firstWait: Awaited<ReturnType<typeof waitForAgent>>) {
  const firstOutput = firstWait.output || firstWait.rawOutput || "";
  const firstSignals = collectTaskSignals(firstOutput);
  const approvalSignal = firstSignals.find((item) => item.kind === "approval");
  const blockerSignal = firstSignals.find((item) => item.kind === "blocker");
  if (!approvalSignal && !blockerSignal) {
    return { finalWait: firstWait, combinedOutput: firstOutput, signals: firstSignals, continuationPrompt: undefined };
  }
  const continuationPrompt = approvalSignal
    ? [
        "Continue autonomously without waiting for more approval unless an external secret, destructive action, or irreversible decision is required.",
        "If you can proceed with a reasonable default, do so and state the assumption briefly in the final report.",
        `Original goal: ${spec.goal}`,
      ].join("\n")
    : [
        "You reported a blocker. Either resolve it now with the available repository/context, or restate the blocker as a concrete final blocker with what was attempted and exactly what is needed next.",
        "Do not stop at a vague status update.",
        `Original goal: ${spec.goal}`,
      ].join("\n");
  await sendToAgent(config, repo, continuationPrompt);
  const secondWait = await waitForAgent(config, repo, Math.max(45, Math.min(600, Math.floor(spec.waitSec / 2))));
  const combinedOutput = [firstOutput, secondWait.output || secondWait.rawOutput || ""].filter(Boolean).join("\n\n").trim();
  return { finalWait: secondWait, combinedOutput, signals: collectTaskSignals(combinedOutput), continuationPrompt };
}

export function synthesizeTaskSummary(spec: TaskSpec, state: Omit<TaskState, "summary">): string {
  const lines = taskOutputLines(state.output || state.rawOutput || "");
  const outcome = findTaskSummaryLine(lines, /\b(outcome|result|completed|finished|shipped|fixed|implemented|blocked|timed out)\b/i)
    || state.blockerSummary
    || state.approvalSummary
    || lines.at(-1)
    || lines[0]
    || (state.phase === "timed_out" ? "Timed out before the agent produced a stable final answer." : "Completed without a concise final line from the agent.");
  const completedCount = state.milestoneStatus.filter((item) => item.status === "inferred_done").length;
  const blockedCount = state.milestoneStatus.filter((item) => item.status === "blocked").length;
  const milestoneLine = state.milestoneStatus.map((item, idx) => `${idx + 1}. ${item.title} — ${item.status === "inferred_done" ? "done" : item.status === "blocked" ? "blocked" : "pending"}`).join("\n");
  const changes = state.signals.filter((item) => item.kind === "change" || item.kind === "milestone").map((item) => item.text).slice(0, 4);
  const validations = state.signals.filter((item) => item.kind === "validation").map((item) => item.text).slice(0, 3);
  const risks = uniqueStrings([
    ...(state.blockerSummary ? [state.blockerSummary] : []),
    ...(state.approvalSummary ? [state.approvalSummary] : []),
    ...state.signals.filter((item) => item.kind === "blocker" || item.kind === "approval" || item.kind === "risk").map((item) => item.text),
  ]).slice(0, 4);
  return [
    `Task report: ${spec.goal}`,
    `Outcome: ${outcome}`,
    `Execution: ${state.mode} via ${state.decision.sessionStrategy} (${state.decision.policy})`,
    `Lane: ${state.decision.lane} / reliability=${state.decision.reliability}`, 
    `Progress: ${completedCount}/${state.milestoneStatus.length} milestones inferred done${blockedCount ? `, ${blockedCount} blocked` : ""}`,
    milestoneLine ? `Milestones:\n${milestoneLine}` : "",
    changes.length ? `Changes / findings:\n${changes.map((line) => `- ${line}`).join("\n")}` : "",
    validations.length ? `Validation:\n${validations.map((line) => `- ${line}`).join("\n")}` : "",
    risks.length ? `Risks / follow-ups:\n${risks.map((line) => `- ${line}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function runTask(config: Required<PluginConfig>, repo: string, goal: string, options?: Partial<TaskSpec> & { contextPaths?: string[]; deliverable?: string }) {
  const spec = compileTaskSpec(config, goal, options);
  const decision = await chooseTaskSession(config, repo, spec);
  const prompt = buildTaskPrompt(spec);
  const stateBase = {
    repo,
    mode: decision.mode,
    phase: "planning" as const,
    milestoneStatus: inferMilestoneStatus(spec.milestones, ""),
    assumptions: spec.assumptions,
    constraints: spec.constraints,
    successCriteria: spec.successCriteria,
    rawOutput: "",
    output: "",
    signals: [] as TaskSignal[],
    blockerSummary: undefined as string | undefined,
    approvalSummary: undefined as string | undefined,
    decision,
  };

  if (decision.mode === "oneshot") {
    const result = await runOneShot(config, repo, prompt, spec.waitSec, spec.model, spec.outputFormat);
    const phase = result.timedOut ? "timed_out" as const : "done" as const;
    const combinedOutput = result.output || result.rawOutput || "";
    const signals = collectTaskSignals(combinedOutput);
    const stateNoSummary: Omit<TaskState, "summary"> = {
      ...stateBase,
      phase,
      milestoneStatus: inferMilestoneStatus(spec.milestones, combinedOutput),
      rawOutput: result.rawOutput,
      output: result.output,
      signals,
      blockerSummary: signals.find((item) => item.kind === "blocker")?.text,
      approvalSummary: signals.find((item) => item.kind === "approval")?.text,
    };
    const summary = synthesizeTaskSummary(spec, stateNoSummary);
    return { action: "task" as const, repo, spec, state: { ...stateNoSummary, summary }, result, ...stableCliMeta("high") };
  }

  let sessionResult;
  if (decision.sessionStrategy === "reuse-live") {
    sessionResult = { repo, cwd: resolveRepo(config, repo).cwd, session: decision.liveSession!, reused: true };
  } else if (decision.sessionStrategy === "resume-recent") {
    sessionResult = await resumeAgent(config, repo, decision.resumedChatId ?? "", spec.model);
  } else {
    sessionResult = await startAgent(config, repo, spec.model);
  }
  for (const contextPath of spec.initialContextPaths) {
    await addContext(config, repo, contextPath);
  }
  await sendToAgent(config, repo, prompt);
  const firstWait = await waitForAgent(config, repo, spec.waitSec);
  const advanced = await maybeAdvanceInteractiveTask(config, repo, spec, firstWait);
  const waited = advanced.finalWait;
  const combinedOutput = advanced.combinedOutput || waited.output || waited.rawOutput || "";
  const cleanedInteractiveOutput = trimBlock(
    normalizeTaskInteractiveOutput(combinedOutput)
      || extractLastAssistantAnswer(combinedOutput)
      || cleanStreamText(combinedOutput)
      || stripCommandEchoNoise(combinedOutput)
      || combinedOutput,
    16000,
  );
  const signals = advanced.signals.length ? advanced.signals : collectTaskSignals(cleanedInteractiveOutput);
  const phase = waited.timedOut ? "timed_out" as const : "done" as const;
  const stateNoSummary: Omit<TaskState, "summary"> = {
    ...stateBase,
    session: sessionResult.session,
    chatId: decision.resumedChatId,
    phase,
    milestoneStatus: inferMilestoneStatus(spec.milestones, cleanedInteractiveOutput),
    rawOutput: combinedOutput,
    output: cleanedInteractiveOutput,
    signals,
    blockerSummary: signals.find((item) => item.kind === "blocker")?.text,
    approvalSummary: signals.find((item) => item.kind === "approval")?.text,
  };
  const summary = synthesizeTaskSummary(spec, stateNoSummary);
  return {
    action: "task" as const,
    repo,
    spec,
    taskPrompt: prompt,
    continuationPrompt: advanced.continuationPrompt,
    state: { ...stateNoSummary, summary },
    result: { ...waited, output: cleanedInteractiveOutput, rawOutput: combinedOutput },
    session: sessionResult,
    ...interactiveMeta("medium"),
  };
}

export async function buildStatus(config: Required<PluginConfig>) {
  let version = "unknown";
  let agentVersion = "unknown";
  try {
    const out = await runQuick(config.binary, ["--version"], process.cwd(), config.timeoutSec, config.apiKey);
    version = out.stdout || out.stderr || version;
  } catch {}
  if (config.allowAgent) {
    try {
      const out = config.agentWindowsBin
        ? await runQuick(getWindowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-Command", `${config.apiKey ? `$env:CURSOR_API_KEY=${quotePsh(config.apiKey)}; ` : ""}& ${quotePsh(config.agentWindowsBin)} --version`], process.cwd(), config.timeoutSec, config.apiKey)
        : config.agentCommand
          ? await runShell(`${config.agentCommand} --version`, process.cwd(), config.timeoutSec, config.apiKey)
          : await runQuick(config.agentBinary, ["--version"], process.cwd(), config.timeoutSec, config.apiKey);
      agentVersion = out.stdout || out.stderr || agentVersion;
    } catch {}
  }
  const sessions = await listSessions(config);
  const prereqs = await checkPrereqs(config);
  const repoChecks = await Promise.all(
    Object.entries(config.repos)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([key, value]) => ({ key, cwd: path.resolve(value), exists: await pathExists(path.resolve(value)) })),
  );
  return {
    version,
    sessions,
    prereqs,
    repoChecks,
    text: [
      "Cursor Bridge status",
      `- enabled: ${config.enabled ? "yes" : "no"}`,
      `- binary: ${config.binary}`,
      `- version: ${version}`,
      `- allowAgent: ${config.allowAgent ? "yes" : "no"}`,
      `- agentBinary: ${config.agentBinary}`,
      `- agentCommand: ${config.agentCommand || "(none)"}`,
      `- agentVersion: ${agentVersion}`,
      `- tmuxPrefix: ${config.tmuxPrefix}`,
      `- prereqs: ${prereqs.ok ? "ok" : "problem"}`,
      `- repos: ${repoChecks.length}`,
      `- activeSessions: ${sessions.length}`,
      ...(!prereqs.ok ? ["", "Problems:", ...prereqs.problems.map((item) => `- ${item}`)] : []),
      ...(repoChecks.length
        ? ["", "Repos:", ...repoChecks.map((repo) => `- ${repo.key}: ${repo.cwd}${repo.exists ? "" : " (missing)"}`)]
        : ["", "Repos:", "- (none configured)"]),
      ...(sessions.length ? ["", "Sessions:", ...sessions.map((s) => `- ${s.session} | windows=${s.windows} | created=${s.created}`)] : []),
    ].join("\n"),
  };
}

function formatHelp(): string {
  return [
    "Cursor Bridge",
    "",
    "Execution lanes:",
    "- Stable CLI lane: run, task(mode=oneshot/auto), models",
    "- Interactive emulation lane: start/send/wait/tail/resume/rules/commands/review/etc.",
    "- Auto task mode now prefers one-shot CLI execution unless config.taskPreferInteractive=true or mode=interactive is explicit",
    "- Interactive slash/picker/session controls are marked as heuristic with lower reliability in tool output",
    "",
    "",
    "Commands:",
    "/cursor status",
    "/cursor repos",
    "/cursor sessions",
    "/cursor open <repo>         — alias for start (starts agent session)",
    "/cursor start <repo> [model=<model>]",
    "/cursor start <repo> :: <initial-prompt> [model=<model>]",
    "/cursor send <repo> :: <instruction>",
    "/cursor tail <repo> [lines]",
    "/cursor stop <repo>",
    "/cursor quit <repo>",
    "/cursor history <repo>",
    "/cursor resume <repo>",
    "/cursor resume <repo> :: <chat-id> [model=<model>]",
    "/cursor resume <repo> :: <chat-id> :: <initial-prompt> [model=<model>]",
    "/cursor models <repo>",
    "/cursor model <repo>",
    "/cursor model <repo> :: <model-name>",
    "/cursor wait <repo> [seconds]",
    "/cursor run <repo> :: <instruction> [model=<model>] [format=<text|json|stream-json>] [wait=<seconds>]",
    "/cursor compress <repo>",
    "/cursor context <repo> :: <path>",
    "/cursor rules <repo>",
    "/cursor commands <repo>",
    "/cursor review <repo>",
    "/cursor attach <repo>",
    "/cursor mcp <repo> :: <enable|disable> <server-name>",
    "/cursor login",
    "/cursor update",
    "",
    "Repo key format: <repo-key> or <repo-key>:<subdir>  (e.g. web_v1:backend)",
    "",
    "Examples:",
    "/cursor open workspace      (same as: /cursor start workspace)",
    "/cursor start workspace",
    "/cursor start workspace model=gpt-5",
    "/cursor start workspace :: 先分析项目结构然后修复登录 bug model=sonnet-4.6",
    "/cursor start web_v1:backend :: 检查 API",
    "/cursor send workspace :: 分析这个项目并修复登录页按钮不显示的问题，直接改代码并说明改动",
    "/cursor tail workspace 120",
    "/cursor history workspace",
    "/cursor resume workspace",
    "/cursor resume workspace :: abc123",
    "/cursor resume workspace :: abc123 :: 继续之前的任务",
    "/cursor resume workspace model=gpt-5",
    "/cursor models workspace",
    "/cursor model workspace",
    "/cursor model workspace :: gpt-5",
    "/cursor wait workspace 60",
    "/cursor run workspace :: 运行测试并报告结果",
    "/cursor run workspace :: 查找安全漏洞 format=json",
    "/cursor compress workspace",
    "/cursor context workspace :: src/components/Login.tsx",
    "/cursor rules workspace",
    "/cursor commands workspace",
    "/cursor review workspace",
    "/cursor attach workspace",
    "/cursor quit workspace",
    "/cursor mcp workspace :: enable my-server",
    "/cursor login",
    "/cursor update",
  ].join("\n");
}

export function parseCommandArgs(rawArgs: string):
  | { action: "status" | "repos" | "help" | "sessions" | "login" | "update" }
  | { action: "run"; subaction: "open" | "start" | "stop"; repo: string; model?: string; initialPrompt?: string }
  | { action: "tail"; repo: string; lines: number }
  | { action: "wait"; repo: string; waitSec: number }
  | { action: "send"; repo: string; text: string }
  | { action: "resume"; repo: string; chatId: string; model?: string; initialPrompt?: string }
  | { action: "run-oneshot"; repo: string; text: string; waitSec: number; model?: string; outputFormat: "text" | "json" | "stream-json" }
  | { action: "task"; repo: string; goal: string; waitSec: number; model?: string; mode: "auto" | "interactive" | "oneshot"; resume: "auto" | "reuse-live" | "resume-recent" | "fresh"; outputFormat: "text" | "json" | "stream-json"; contextPaths: string[]; deliverable?: string }
  | { action: "history"; repo: string }
  | { action: "models"; repo: string }
  | { action: "model"; repo: string; modelName?: string }
  | { action: "compress"; repo: string }
  | { action: "mcp"; repo: string; mcpAction: "enable" | "disable"; mcpServer: string }
  | { action: "context"; repo: string; contextPath: string }
  | { action: "rules" | "commands" | "review" | "quit" | "attach"; repo: string }
  | { action: "error"; message: string } {
  const args = rawArgs.trim();
  if (!args) return { action: "help" };
  const split = shellSplit(args);
  const cmd = (split[0] ?? "").toLowerCase();
  if (cmd === "status" || cmd === "repos" || cmd === "help" || cmd === "sessions" || cmd === "login" || cmd === "update") return { action: cmd };

  if (cmd === "send") {
    const marker = "::";
    const body = args.slice(cmd.length).trim();
    const idx = body.indexOf(marker);
    if (idx === -1) return { action: "error", message: "Usage: /cursor send <repo> :: <instruction>" };
    const repo = body.slice(0, idx).trim();
    const text = body.slice(idx + marker.length).trim();
    if (!repo || !text) return { action: "error", message: "Usage: /cursor send <repo> :: <instruction>" };
    return { action: "send", repo, text };
  }

  if (cmd === "resume") {
    // Formats:
    //   /cursor resume <repo>
    //   /cursor resume <repo> [model=<model>]
    //   /cursor resume <repo> :: <chat-id> [model=<model>]
    //   /cursor resume <repo> :: <chat-id> :: <initial-prompt> [model=<model>]
    const marker = "::";
    const body = args.slice(cmd.length).trim();
    const firstIdx = body.indexOf(marker);
    if (firstIdx === -1) {
      const parts = shellSplit(body);
      const repo = (parts[0] ?? "").trim();
      if (!repo) return { action: "error", message: "Usage: /cursor resume <repo> [:: <chat-id> [:: <initial-prompt>]] [model=<model>]" };
      const modelArg = parts.find((s) => s.startsWith("model="));
      const model = modelArg ? modelArg.slice("model=".length).trim() : undefined;
      return { action: "resume", repo, chatId: "", model };
    }
    const repo = body.slice(0, firstIdx).trim();
    if (!repo) return { action: "error", message: "Usage: /cursor resume <repo> [:: <chat-id> [:: <initial-prompt>]] [model=<model>]" };
    let rest = body.slice(firstIdx + marker.length).trim();
    // Extract trailing model= flag first
    const modelMatch = rest.match(/\bmodel=(\S+)\s*$/);
    const model = modelMatch?.[1];
    if (modelMatch) rest = rest.slice(0, rest.length - modelMatch[0].length).trim();
    // Check for a second :: separating chatId from initialPrompt
    const secondIdx = rest.indexOf(marker);
    let chatId: string;
    let initialPrompt: string | undefined;
    if (secondIdx !== -1) {
      chatId = rest.slice(0, secondIdx).trim();
      initialPrompt = rest.slice(secondIdx + marker.length).trim() || undefined;
    } else {
      chatId = rest;
    }
    return { action: "resume", repo, chatId, model, initialPrompt };
  }

  if (cmd === "model") {
    // `/cursor model <repo>` — open picker
    // `/cursor model <repo> :: <model-name>` — select specific model
    const marker = "::";
    const body = args.slice(cmd.length).trim();
    const idx = body.indexOf(marker);
    if (idx === -1) {
      const repo = body.trim();
      if (!repo) return { action: "error", message: "Usage: /cursor model <repo> [:: <model-name>]" };
      return { action: "model", repo };
    }
    const repo = body.slice(0, idx).trim();
    const modelName = body.slice(idx + marker.length).trim();
    if (!repo) return { action: "error", message: "Usage: /cursor model <repo> [:: <model-name>]" };
    return { action: "model", repo, modelName };
  }

  if (cmd === "task") {
    const marker = "::";
    const body = args.slice(cmd.length).trim();
    const idx = body.indexOf(marker);
    if (idx === -1) return { action: "error", message: "Usage: /cursor task <repo> :: <goal> [model=<model>] [mode=<auto|interactive|oneshot>] [resume=<auto|reuse-live|resume-recent|fresh>] [format=<text|json|stream-json>] [wait=<seconds>] [context=a,b] [deliverable=...]" };
    const repo = body.slice(0, idx).trim();
    const parsedOptions = parseTrailingInlineOptions(body.slice(idx + marker.length).trim(), ["model", "format", "wait", "mode", "resume", "context", "deliverable"]);
    const waitSec = parsedOptions.waitSec ? Math.max(30, Math.min(1800, parsedOptions.waitSec)) : 240;
    const outputFormat = parsedOptions.outputFormat ?? "text";
    const resume = parsedOptions.resume ?? "auto";
    const mode = parsedOptions.mode ?? "auto";
    const model = parsedOptions.model;
    const contextPaths = parsedOptions.contextPaths ?? [];
    const deliverable = parsedOptions.deliverable;
    const goal = parsedOptions.remainder;
    if (!repo || !goal) return { action: "error", message: "Usage: /cursor task <repo> :: <goal> [model=<model>] [mode=<auto|interactive|oneshot>] [resume=<auto|reuse-live|resume-recent|fresh>] [format=<text|json|stream-json>] [wait=<seconds>] [context=a,b] [deliverable=...]" };
    return { action: "task", repo, goal, waitSec, model, mode, resume, outputFormat, contextPaths, deliverable };
  }

  if (cmd === "run") {
    const marker = "::";
    const body = args.slice(cmd.length).trim();
    const idx = body.indexOf(marker);
    if (idx === -1) return { action: "error", message: "Usage: /cursor run <repo> :: <instruction> [model=<model>] [format=<text|json|stream-json>] [wait=<seconds>]" };
    const repo = body.slice(0, idx).trim();
    const parsedOptions = parseTrailingInlineOptions(body.slice(idx + marker.length).trim(), ["model", "format", "wait"]);
    const waitSec = parsedOptions.waitSec ? Math.max(10, Math.min(600, parsedOptions.waitSec)) : 120;
    const outputFormat = parsedOptions.outputFormat ?? "text";
    const model = parsedOptions.model;
    const text = parsedOptions.remainder;
    if (!repo || !text) return { action: "error", message: "Usage: /cursor run <repo> :: <instruction> [model=<model>] [format=<text|json|stream-json>] [wait=<seconds>]" };
    return { action: "run-oneshot", repo, text, waitSec, model, outputFormat };
  }

  if (cmd === "mcp") {
    const marker = "::";
    const body = args.slice(cmd.length).trim();
    const idx = body.indexOf(marker);
    if (idx === -1) return { action: "error", message: "Usage: /cursor mcp <repo> :: <enable|disable> <server-name>" };
    const repo = body.slice(0, idx).trim();
    const rest = body.slice(idx + marker.length).trim();
    const parts = shellSplit(rest);
    const mcpAction = (parts[0] ?? "").toLowerCase();
    const mcpServer = parts.slice(1).join(" ").trim();
    if (!repo || (mcpAction !== "enable" && mcpAction !== "disable") || !mcpServer) {
      return { action: "error", message: "Usage: /cursor mcp <repo> :: <enable|disable> <server-name>" };
    }
    return { action: "mcp", repo, mcpAction: mcpAction as "enable" | "disable", mcpServer };
  }

  if (cmd === "tail") {
    const repo = (split[1] ?? "").trim();
    const rawLines = Number(split[2] ?? 80);
    const lines = Number.isFinite(rawLines) ? Math.max(1, Math.min(400, Math.floor(rawLines))) : 80;
    if (!repo) return { action: "error", message: "Usage: /cursor tail <repo> [lines]" };
    return { action: "tail", repo, lines };
  }

  if (cmd === "wait") {
    const repo = (split[1] ?? "").trim();
    const rawSec = Number(split[2] ?? 120);
    const waitSec = Number.isFinite(rawSec) ? Math.max(5, Math.min(600, Math.floor(rawSec))) : 120;
    if (!repo) return { action: "error", message: "Usage: /cursor wait <repo> [seconds]" };
    return { action: "wait", repo, waitSec };
  }

  if (cmd === "history") {
    const repo = (split[1] ?? "").trim();
    if (!repo) return { action: "error", message: "Usage: /cursor history <repo>" };
    return { action: "history", repo };
  }

  if (cmd === "models") {
    const repo = (split[1] ?? "").trim();
    if (!repo) return { action: "error", message: "Usage: /cursor models <repo>" };
    return { action: "models", repo };
  }

  if (cmd === "compress") {
    const repo = (split[1] ?? "").trim();
    if (!repo) return { action: "error", message: "Usage: /cursor compress <repo>" };
    return { action: "compress", repo };
  }

  if (cmd === "context") {
    // `/cursor context <repo> :: <path>`
    const marker = "::";
    const body = args.slice(cmd.length).trim();
    const idx = body.indexOf(marker);
    if (idx === -1) return { action: "error", message: "Usage: /cursor context <repo> :: <path>" };
    const repo = body.slice(0, idx).trim();
    const contextPath = body.slice(idx + marker.length).trim();
    if (!repo || !contextPath) return { action: "error", message: "Usage: /cursor context <repo> :: <path>" };
    return { action: "context", repo, contextPath };
  }

  if (cmd === "rules" || cmd === "commands" || cmd === "review" || cmd === "quit" || cmd === "attach") {
    const repo = (split[1] ?? "").trim();
    if (!repo) return { action: "error", message: `Usage: /cursor ${cmd} <repo>` };
    return { action: cmd, repo };
  }

  if (!["open", "start", "stop"].includes(cmd)) return { action: "error", message: `Unknown subcommand: ${cmd}` };
  const repo = (split[1] ?? "").trim();
  if (!repo) return { action: "error", message: `Usage: /cursor ${cmd} <repo>` };
  // start supports optional model=<name> and initial prompt via `::`
  if (cmd === "start") {
    const marker = "::";
    const body = args.slice(cmd.length).trim();
    const idx = body.indexOf(marker);
    if (idx !== -1) {
      // `/cursor start <repo> :: <initial-prompt> [model=<model>]`
      const repoFromBody = body.slice(0, idx).trim();
      let rest = body.slice(idx + marker.length).trim();
      const modelMatch = rest.match(/\bmodel=(\S+)\s*$/);
      const model = modelMatch?.[1];
      if (modelMatch) rest = rest.slice(0, rest.length - modelMatch[0].length).trim();
      const initialPrompt = rest || undefined;
      if (!repoFromBody) return { action: "error", message: "Usage: /cursor start <repo> [:: <initial-prompt>] [model=<model>]" };
      return { action: "run", subaction: "start", repo: repoFromBody, model, initialPrompt };
    }
    const modelArg = split.find((s) => s.startsWith("model="));
    const model = modelArg ? modelArg.slice("model=".length).trim() : undefined;
    return { action: "run", subaction: "start", repo, model };
  }
  return { action: "run", subaction: cmd as "open" | "stop", repo };
}

export default function register(api: OpenClawPluginApi) {
  const config = normalizeConfig(api.pluginConfig);

  api.registerCommand({
    name: "cursor",
    description: "Open Cursor or drive Cursor agent sessions for a whitelisted repo.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseCommandArgs(ctx.args?.trim() ?? "");
      if (parsed.action === "help") return { text: formatHelp() };
      if (parsed.action === "error") return { text: `${parsed.message}\n\n${formatHelp()}` };
      if (parsed.action === "status") return { text: (await buildStatus(config)).text };
      if (parsed.action === "login") {
        const result = await loginAgent(config);
        return { text: `Login started\n- session: ${result.session}\n\n${result.output || "(waiting for browser...)"}` };
      }
      if (parsed.action === "update") {
        const result = await updateAgent(config);
        return { text: result.output || "(no output)" };
      }
      if (parsed.action === "repos") {
        const repoLines = Object.entries(config.repos)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `- ${key}: ${path.resolve(value)}`);
        return { text: repoLines.length ? repoLines.join("\n") : "No repos configured." };
      }
      if (parsed.action === "sessions") {
        const sessions = await listSessions(config);
        return {
          text: sessions.length
            ? sessions.map((s) => `- ${s.session} | windows=${s.windows} | created=${s.created}`).join("\n")
            : "No active Cursor tmux sessions.",
        };
      }
      try {
        if (parsed.action === "send") {
          const result = await sendToAgent(config, parsed.repo, parsed.text);
          return { text: `Sent to Cursor agent\n- repo: ${result.repo}\n- session: ${result.session}\n- text: ${result.sent}` };
        }
        if (parsed.action === "tail") {
          const result = await tailAgent(config, parsed.repo, parsed.lines);
          return { text: `Cursor session output\n- repo: ${result.repo}\n- session: ${result.session}\n- lines: ${result.lines}\n\n${result.output || "(no output)"}` };
        }
        if (parsed.action === "wait") {
          const result = await waitForAgent(config, parsed.repo, parsed.waitSec);
          return { text: `${result.timedOut ? "Timed out waiting for" : "Agent finished in"} ${result.repo}\n- session: ${result.session}\n\n${result.output || "(no output)"}` };
        }
        if (parsed.action === "history") {
          const { cwd } = resolveRepo(config, parsed.repo);
          const result = await listHistory(config, cwd);
          const hint = "\n\n(用 /cursor resume <repo> :: <chat-id> 接续指定对话)";
          const body = result.entries.length
            ? result.entries.map((e) => `- ${e.id}  ${e.title}`).join("\n")
            : result.output || "(no history)";
          return { text: body + hint };
        }
        if (parsed.action === "models") {
          const { cwd } = resolveRepo(config, parsed.repo);
          const result = await listModels(config, cwd);
          return { text: result.output || "(no models listed)" };
        }
        if (parsed.action === "resume") {
          const result = await resumeAgent(config, parsed.repo, parsed.chatId, parsed.model, parsed.initialPrompt);
          return { text: `Resumed Cursor agent session\n- repo: ${result.repo}\n- cwd: ${result.cwd}\n- session: ${result.session}\n- chatId: ${result.chatId}\n- model: ${result.model}` };
        }
        if (parsed.action === "run-oneshot") {
          const result = await runOneShot(config, parsed.repo, parsed.text, parsed.waitSec, parsed.model, parsed.outputFormat);
          return { text: `${result.timedOut ? "Run timed out for" : "Run finished for"} ${result.repo}\n- prompt: ${result.prompt}\n\n${result.output || "(no output)"}` };
        }
        if (parsed.action === "compress") {
          const result = await compressSession(config, parsed.repo);
          return { text: `Sent /compress to session\n- repo: ${result.repo}\n- session: ${result.session}` };
        }
        if (parsed.action === "model") {
          const result = await switchModel(config, parsed.repo, parsed.modelName);
          return { text: `Switched model in session\n- repo: ${result.repo}\n- session: ${result.session}\n- model: ${result.modelName}` };
        }
        if (parsed.action === "mcp") {
          const result = await mcpControl(config, parsed.repo, parsed.mcpAction, parsed.mcpServer);
          return { text: `Sent /mcp ${result.mcpAction} ${result.mcpServer}\n- repo: ${result.repo}\n- session: ${result.session}` };
        }
        if (parsed.action === "context") {
          const result = await addContext(config, parsed.repo, parsed.contextPath);
          return { text: `Added context reference\n- repo: ${result.repo}\n- session: ${result.session}\n- path: ${result.contextPath}` };
        }
        if (parsed.action === "rules") {
          const result = await showRules(config, parsed.repo);
          return { text: `Sent /rules to session\n- repo: ${result.repo}\n- session: ${result.session}\n\n${result.output || "(no output)"}` };
        }
        if (parsed.action === "commands") {
          const result = await showCommands(config, parsed.repo);
          return { text: `Sent /commands to session\n- repo: ${result.repo}\n- session: ${result.session}\n\n${result.output || "(no output)"}` };
        }
        if (parsed.action === "review") {
          const result = await reviewSession(config, parsed.repo);
          return { text: `Sent Ctrl+R (review) to session\n- repo: ${result.repo}\n- session: ${result.session}` };
        }
        if (parsed.action === "quit") {
          const result = await quitSession(config, parsed.repo);
          return { text: `${result.stopped ? "Quit" : "No running session for"} ${result.repo}\n- session: ${result.session}` };
        }
        if (parsed.action === "attach") {
          const result = await attachSession(config, parsed.repo);
          const status = result.exists ? (result.alive ? "agent running" : "session exists, agent may have exited") : "no session";
          return { text: `Attach command for ${result.repo}\n- session: ${result.session}\n- status: ${status}\n\nRun in your terminal:\n  ${result.command}` };
        }
        if (parsed.action === "run" && parsed.subaction === "open") {
          const result = await openRepo(config, parsed.repo);
          return { text: `${result.reused ? "Cursor agent session already exists" : "Started Cursor agent session"}\n- repo: ${result.repo}\n- cwd: ${result.cwd}\n- session: ${result.session}` };
        }
        if (parsed.action === "run" && parsed.subaction === "start") {
          const result = await startAgent(config, parsed.repo, parsed.model, parsed.initialPrompt);
          return { text: `${result.reused ? "Cursor agent session already exists" : "Started Cursor agent session"}\n- repo: ${result.repo}\n- cwd: ${result.cwd}\n- session: ${result.session}` };
        }
        if (parsed.action === "run" && parsed.subaction === "stop") {
          const result = await stopAgent(config, parsed.repo);
          return { text: `${result.stopped ? "Stopped" : "No running session for"} ${result.repo}\n- session: ${result.session}` };
        }
        return { text: formatHelp() };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.error(`[cursor-bridge] ${message}`);
        return { text: `Cursor Bridge error: ${message}` };
      }
    },
  });

  api.registerTool(
    {
      name: "cursor_bridge",
      description: "Open Cursor or drive a repo-scoped Cursor agent tmux session.",
      parameters: CursorToolSchema,
      async execute(_id, params) {
        const action = (params.action as ToolAction | undefined) ?? "sessions";
        const repo = String(params.repo ?? "");
        if (action === "status") {
          const status = await buildStatus(config);
          return { content: [{ type: "text", text: status.text }], details: status };
        }
        if (action === "login") {
          const result = await loginAgent(config);
          return { content: [{ type: "text", text: result.output || "(login started)" }], details: result };
        }
        if (action === "update") {
          const result = await updateAgent(config);
          return { content: [{ type: "text", text: result.output || "(no output)" }], details: result };
        }
        if (action === "repos") {
          const repos = Object.entries(config.repos)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => ({ key, cwd: path.resolve(value) }));
          return {
            content: [{ type: "text", text: repos.length ? repos.map((r) => `- ${r.key}: ${r.cwd}`).join("\n") : "No repos configured." }],
            details: { repos },
          };
        }
        if (action === "sessions") {
          const sessions = await listSessions(config);
          return {
            content: [{ type: "text", text: sessions.length ? sessions.map((s) => `${s.session} | windows=${s.windows} | created=${s.created}`).join("\n") : "No active Cursor tmux sessions." }],
            details: { sessions },
          };
        }
        if (!repo) throw new Error("repo is required for this action");
        if (action === "open") {
          const result = await openRepo(config, repo);
          return { content: [{ type: "text", text: `${result.reused ? "Reused" : "Started"} Cursor agent session ${result.session}` }], details: result };
        }
        if (action === "start") {
          const model = params.model ? String(params.model) : undefined;
          const initialPrompt = params.initialPrompt ? String(params.initialPrompt) : undefined;
          const result = await startAgent(config, repo, model, initialPrompt);
          return { content: [{ type: "text", text: `Started Cursor agent session ${result.session}` }], details: result };
        }
        if (action === "send") {
          const text = String(params.text ?? "");
          if (!text) throw new Error("text is required for send");
          const result = await sendToAgent(config, repo, text);
          return { content: [{ type: "text", text: `Sent instruction to ${result.session}` }], details: result };
        }
        if (action === "tail") {
          const lines = typeof params.lines === "number" ? params.lines : 80;
          const result = await tailAgent(config, repo, lines);
          return { content: [{ type: "text", text: result.output || "(no output)" }], details: result };
        }
        if (action === "wait") {
          const waitSec = typeof params.waitSec === "number" ? params.waitSec : 120;
          const result = await waitForAgent(config, repo, waitSec);
          return { content: [{ type: "text", text: result.output || "(no output)" }], details: result };
        }
        if (action === "history") {
          const { cwd } = resolveRepo(config, repo);
          const result = await listHistory(config, cwd);
          const text = result.entries.length
            ? result.entries.map((e) => `- ${e.id}  ${e.title}`).join("\n")
            : result.output || "(no history)";
          return { content: [{ type: "text", text }], details: result };
        }
        if (action === "models") {
          const { cwd } = resolveRepo(config, repo);
          const result = await listModels(config, cwd);
          return { content: [{ type: "text", text: result.output || "(no models listed)" }], details: result };
        }
        if (action === "resume") {
          const chatId = String(params.chatId ?? "");
          const model = params.model ? String(params.model) : undefined;
          const initialPrompt = params.initialPrompt ? String(params.initialPrompt) : undefined;
          const result = await resumeAgent(config, repo, chatId, model, initialPrompt);
          return { content: [{ type: "text", text: `Resumed session ${result.session} (${result.chatId}) model: ${result.model}` }], details: result };
        }
        if (action === "run") {
          const text = String(params.text ?? "");
          if (!text) throw new Error("text is required for run");
          const waitSec = typeof params.waitSec === "number" ? params.waitSec : 120;
          const model = params.model ? String(params.model) : undefined;
          const outputFormat = (["text", "json", "stream-json"].includes(String(params.outputFormat ?? "")) ? String(params.outputFormat) : "text") as "text" | "json" | "stream-json";
          const result = await runOneShot(config, repo, text, waitSec, model, outputFormat);
          return { content: [{ type: "text", text: result.output || "(no output)" }], details: result };
        }
        if (action === "task") {
          const goal = String(params.goal ?? params.text ?? "").trim();
          if (!goal) throw new Error("goal is required for task");
          const waitSec = typeof params.waitSec === "number" ? params.waitSec : config.taskDefaultWaitSec;
          const model = params.model ? String(params.model) : undefined;
          const outputFormat = (["text", "json", "stream-json"].includes(String(params.outputFormat ?? "")) ? String(params.outputFormat) : "text") as "text" | "json" | "stream-json";
          const mode = (["auto", "interactive", "oneshot"].includes(String((params as any).mode ?? "")) ? String((params as any).mode) : "auto") as "auto" | "interactive" | "oneshot";
          const resume = (["auto", "reuse-live", "resume-recent", "fresh"].includes(String((params as any).resume ?? "")) ? String((params as any).resume) : "auto") as "auto" | "reuse-live" | "resume-recent" | "fresh";
          const contextPaths = Array.isArray((params as any).contextPaths) ? (params as any).contextPaths.map((item: unknown) => String(item)) : [];
          const deliverable = (params as any).deliverable ? String((params as any).deliverable) : undefined;
          const result = await runTask(config, repo, goal, { waitSec, model, outputFormat, mode, resume, contextPaths, deliverable });
          return { content: [{ type: "text", text: `${result.state.summary}

${result.state.output || "(no output)"}` }], details: result };
        }
        if (action === "compress") {
          const result = await compressSession(config, repo);
          return { content: [{ type: "text", text: `Sent /compress to ${result.session}` }], details: result };
        }
        if (action === "model") {
          const modelName = params.model ? String(params.model) : undefined;
          const result = await switchModel(config, repo, modelName);
          return { content: [{ type: "text", text: `Model switched in ${result.session}: ${result.modelName}` }], details: result };
        }
        if (action === "mcp") {
          const mcpAction = String(params.mcpAction ?? "") as "enable" | "disable";
          const mcpServer = String(params.mcpServer ?? "");
          if (mcpAction !== "enable" && mcpAction !== "disable") throw new Error("mcpAction must be 'enable' or 'disable'");
          if (!mcpServer) throw new Error("mcpServer is required for mcp action");
          const result = await mcpControl(config, repo, mcpAction, mcpServer);
          return { content: [{ type: "text", text: `Sent /mcp ${result.mcpAction} ${result.mcpServer} to ${result.session}` }], details: result };
        }
        if (action === "context") {
          const contextPath = String(params.contextPath ?? "");
          if (!contextPath) throw new Error("contextPath is required for context action");
          const result = await addContext(config, repo, contextPath);
          return { content: [{ type: "text", text: `Added context ${result.contextPath} to ${result.session}` }], details: result };
        }
        if (action === "rules") {
          const result = await showRules(config, repo);
          return { content: [{ type: "text", text: result.output || "(no output)" }], details: result };
        }
        if (action === "commands") {
          const result = await showCommands(config, repo);
          return { content: [{ type: "text", text: result.output || "(no output)" }], details: result };
        }
        if (action === "review") {
          const result = await reviewSession(config, repo);
          return { content: [{ type: "text", text: `Sent Ctrl+R to ${result.session}` }], details: result };
        }
        if (action === "quit") {
          const result = await quitSession(config, repo);
          return { content: [{ type: "text", text: result.stopped ? `Quit ${result.session}` : `No running session ${result.session}` }], details: result };
        }
        if (action === "attach") {
          const result = await attachSession(config, repo);
          return { content: [{ type: "text", text: `${result.command}` }], details: result };
        }
        const result = await stopAgent(config, repo);
        return { content: [{ type: "text", text: result.stopped ? `Stopped ${result.session}` : `No running session ${result.session}` }], details: result };
      },
    },
    { optional: true },
  );
}
