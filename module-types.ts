export type Reliability = "high" | "medium" | "low";

export type RepoResolver = (config: { repos: Record<string, string> }, repo: string) => { key: string; cwd?: string };
export type SessionNamer = (config: { tmuxPrefix: string }, key: string) => string;
export type SessionExists = (session: string) => Promise<boolean>;
export type SessionAlive = (session: string) => Promise<boolean>;
export type RunTmux = (args: string[], timeoutSec?: number) => Promise<any>;
export type Sleep = (ms: number) => Promise<void>;
export type MarkStreamOffset = (session: string) => Promise<number>;
export type TrimBlock = (text: string, max?: number) => string;

export type InteractiveSessionDeps = {
  resolveRepo: RepoResolver;
  tmuxSessionName: SessionNamer;
  tmuxSessionExists: SessionExists;
  isAgentAlive: SessionAlive;
};

export type InteractiveActionDeps = InteractiveSessionDeps & {
  runTmux: RunTmux;
  sleep?: Sleep;
  markStreamOffset?: MarkStreamOffset;
  captureSlashCommandOutput?: (session: string, slashCommand: "/rules" | "/commands", lines: number) => Promise<string>;
  trimBlock?: TrimBlock;
};

export type StableCliMeta = (reliability?: Reliability) => {
  lane: "stable-cli";
  reliability: Reliability;
  implementation: string;
  heuristic: boolean;
};

export type InteractiveMeta = (reliability?: Reliability) => {
  lane: "interactive-emulated";
  reliability: Reliability;
  implementation: string;
  heuristic: boolean;
};

export type CliLaneDeps = {
  ensureGitWrapper: (config: { enableGitWrapper?: boolean }) => Promise<string | null>;
  buildAgentLaunch: (config: any, cwd: string, model?: string, gitWrapperWindowsPath?: string | null, extraAgentArgs?: string) => { command: string; display: string };
  runTmux: RunTmux;
  sleep: Sleep;
  trimBlock: TrimBlock;
  interactiveMeta: InteractiveMeta;
  stableCliMeta: StableCliMeta;
  getWindowsPowerShellPath: () => string;
  linuxToWindowsPath: (linuxPath: string) => string;
  quotePsh: (value: string) => string;
  quoteSh: (value: string) => string;
  runQuick: (binary: string, args: string[], cwd: string, timeoutSec: number, apiKey?: string) => Promise<{ stdout: string; stderr: string }>;
  runShell: (command: string, cwd: string, timeoutSec: number, apiKey?: string) => Promise<{ stdout: string; stderr: string }>;
  resolveRepo: RepoResolver;
  pathExists: (p: string) => Promise<boolean>;
  tmuxSessionName: SessionNamer;
  maybeRetryAgentLaunch: <T>(kind: "start" | "resume" | "run", session: string, attempt: number, launch: () => Promise<T>) => Promise<T>;
  isTransientAgentError: (text: string) => boolean;
};

export type TaskOrchestratorDeps = {
  resolveRepo: RepoResolver;
  tmuxSessionName: SessionNamer;
  tmuxSessionExists: SessionExists;
  isAgentAlive: SessionAlive;
  listHistory: (config: any, cwd: string) => Promise<{ entries: Array<{ id: string; title: string; raw?: string }>; output: string }>;
  runOneShot: (config: any, repo: string, text: string, waitSec?: number, model?: string, outputFormat?: "text" | "json" | "stream-json") => Promise<any>;
  resumeAgent: (config: any, repo: string, chatId: string, model?: string, initialPrompt?: string) => Promise<any>;
  startAgent: (config: any, repo: string, model?: string, initialPrompt?: string) => Promise<any>;
  addContext: (config: any, repo: string, contextPath: string) => Promise<any>;
  sendToAgent: (config: any, repo: string, text: string) => Promise<any>;
  waitForAgent: (config: any, repo: string, waitSec?: number) => Promise<any>;
  trimBlock: TrimBlock;
  stableCliMeta: StableCliMeta;
  interactiveMeta: InteractiveMeta;
};
