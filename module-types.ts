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
