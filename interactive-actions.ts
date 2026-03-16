export function interactiveMeta(reliability = "medium" as "high" | "medium" | "low") {
  return {
    lane: "interactive-emulated" as const,
    reliability,
    implementation: "tmux-pane-emulation",
    heuristic: true,
  };
}

export function interactiveResult<T extends Record<string, unknown>>(payload: T, reliability = "medium" as "high" | "medium" | "low") {
  return { ...payload, ...interactiveMeta(reliability) };
}

export async function requireInteractiveSession(
  config: { allowAgent: boolean },
  repo: string,
  resolveRepo: (config: any, repo: string) => { key: string },
  tmuxSessionName: (config: any, key: string) => string,
  tmuxSessionExists: (session: string) => Promise<boolean>,
  isAgentAlive: (session: string) => Promise<boolean>,
) {
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const { key } = resolveRepo(config as any, repo);
  const session = tmuxSessionName(config as any, key);
  if (!(await tmuxSessionExists(session))) {
    throw new Error(`No active Cursor session for ${key}. Start one with /cursor start ${key}`);
  }
  if (!(await isAgentAlive(session))) {
    throw new Error(`Agent in session ${session} appears to have exited. Restart with /cursor start ${key}`);
  }
  return { key, session };
}

export async function runInteractiveSlashCommand(session: string, slashCommand: string, markStreamOffset: (session: string) => Promise<number>, runTmux: (args: string[], timeoutSec?: number) => Promise<any>) {
  await markStreamOffset(session);
  await runTmux(["send-keys", "-t", session, slashCommand, "Enter"], 10);
}

export async function compressSession(
  config: any,
  repo: string,
  deps: {
    requireInteractiveSession: typeof requireInteractiveSession,
    runInteractiveSlashCommand: typeof runInteractiveSlashCommand,
    markStreamOffset: (session: string) => Promise<number>,
    runTmux: (args: string[], timeoutSec?: number) => Promise<any>,
    interactiveResult: typeof interactiveResult,
    resolveRepo: any,
    tmuxSessionName: any,
    tmuxSessionExists: any,
    isAgentAlive: any,
  },
) {
  const { key, session } = await deps.requireInteractiveSession(config, repo, deps.resolveRepo, deps.tmuxSessionName, deps.tmuxSessionExists, deps.isAgentAlive);
  await deps.runInteractiveSlashCommand(session, "/compress", deps.markStreamOffset, deps.runTmux);
  return deps.interactiveResult({ action: "compress" as const, repo: key, session }, "low");
}

export async function mcpControl(
  config: any,
  repo: string,
  mcpAction: "enable" | "disable",
  mcpServer: string,
  deps: {
    requireInteractiveSession: typeof requireInteractiveSession,
    runInteractiveSlashCommand: typeof runInteractiveSlashCommand,
    markStreamOffset: (session: string) => Promise<number>,
    runTmux: (args: string[], timeoutSec?: number) => Promise<any>,
    interactiveResult: typeof interactiveResult,
    resolveRepo: any,
    tmuxSessionName: any,
    tmuxSessionExists: any,
    isAgentAlive: any,
  },
) {
  const { key, session } = await deps.requireInteractiveSession(config, repo, deps.resolveRepo, deps.tmuxSessionName, deps.tmuxSessionExists, deps.isAgentAlive);
  await deps.runInteractiveSlashCommand(session, `/mcp ${mcpAction} ${mcpServer}`, deps.markStreamOffset, deps.runTmux);
  return deps.interactiveResult({ action: "mcp" as const, repo: key, session, mcpAction, mcpServer }, "low");
}

export async function switchModel(
  config: any,
  repo: string,
  modelName: string | undefined,
  deps: {
    requireInteractiveSession: typeof requireInteractiveSession,
    runInteractiveSlashCommand: typeof runInteractiveSlashCommand,
    markStreamOffset: (session: string) => Promise<number>,
    runTmux: (args: string[], timeoutSec?: number) => Promise<any>,
    sleep: (ms: number) => Promise<void>,
    interactiveResult: typeof interactiveResult,
    resolveRepo: any,
    tmuxSessionName: any,
    tmuxSessionExists: any,
    isAgentAlive: any,
  },
) {
  const { key, session } = await deps.requireInteractiveSession(config, repo, deps.resolveRepo, deps.tmuxSessionName, deps.tmuxSessionExists, deps.isAgentAlive);
  await deps.runInteractiveSlashCommand(session, "/models", deps.markStreamOffset, deps.runTmux);
  if (modelName) {
    await deps.sleep(800);
    await deps.runTmux(["send-keys", "-t", session, "-l", "--", modelName], 10);
    await deps.sleep(400);
    await deps.runTmux(["send-keys", "-t", session, "Enter", ""], 10);
  }
  return deps.interactiveResult({ action: "model" as const, repo: key, session, modelName: modelName || "(picker opened)" }, "low");
}

export async function addContext(
  config: any,
  repo: string,
  contextPath: string,
  deps: {
    requireInteractiveSession: typeof requireInteractiveSession,
    runTmux: (args: string[], timeoutSec?: number) => Promise<any>,
    sleep: (ms: number) => Promise<void>,
    interactiveResult: typeof interactiveResult,
    resolveRepo: any,
    tmuxSessionName: any,
    tmuxSessionExists: any,
    isAgentAlive: any,
  },
) {
  const { key, session } = await deps.requireInteractiveSession(config, repo, deps.resolveRepo, deps.tmuxSessionName, deps.tmuxSessionExists, deps.isAgentAlive);
  const ref = contextPath.startsWith("@") ? contextPath : `@${contextPath}`;
  await deps.runTmux(["send-keys", "-t", session, "-l", "--", ref], 10);
  await deps.sleep(300);
  await deps.runTmux(["send-keys", "-t", session, " "], 10);
  return deps.interactiveResult({ action: "context" as const, repo: key, session, contextPath: ref }, "low");
}

export async function showRules(
  config: any,
  repo: string,
  deps: {
    requireInteractiveSession: typeof requireInteractiveSession,
    runInteractiveSlashCommand: typeof runInteractiveSlashCommand,
    markStreamOffset: (session: string) => Promise<number>,
    runTmux: (args: string[], timeoutSec?: number) => Promise<any>,
    captureSlashCommandOutput: (session: string, slashCommand: "/rules" | "/commands", lines: number) => Promise<string>,
    trimBlock: (text: string, max?: number) => string,
    interactiveResult: typeof interactiveResult,
    resolveRepo: any,
    tmuxSessionName: any,
    tmuxSessionExists: any,
    isAgentAlive: any,
  },
) {
  const { key, session } = await deps.requireInteractiveSession(config, repo, deps.resolveRepo, deps.tmuxSessionName, deps.tmuxSessionExists, deps.isAgentAlive);
  await deps.runInteractiveSlashCommand(session, "/rules", deps.markStreamOffset, deps.runTmux);
  const cleaned = await deps.captureSlashCommandOutput(session, "/rules", 60);
  return deps.interactiveResult({ action: "rules" as const, repo: key, session, output: deps.trimBlock(cleaned, 8000) }, "low");
}

export async function showCommands(
  config: any,
  repo: string,
  deps: {
    requireInteractiveSession: typeof requireInteractiveSession,
    runInteractiveSlashCommand: typeof runInteractiveSlashCommand,
    markStreamOffset: (session: string) => Promise<number>,
    runTmux: (args: string[], timeoutSec?: number) => Promise<any>,
    captureSlashCommandOutput: (session: string, slashCommand: "/rules" | "/commands", lines: number) => Promise<string>,
    trimBlock: (text: string, max?: number) => string,
    interactiveResult: typeof interactiveResult,
    resolveRepo: any,
    tmuxSessionName: any,
    tmuxSessionExists: any,
    isAgentAlive: any,
  },
) {
  const { key, session } = await deps.requireInteractiveSession(config, repo, deps.resolveRepo, deps.tmuxSessionName, deps.tmuxSessionExists, deps.isAgentAlive);
  await deps.runInteractiveSlashCommand(session, "/commands", deps.markStreamOffset, deps.runTmux);
  const cleaned = await deps.captureSlashCommandOutput(session, "/commands", 70);
  return deps.interactiveResult({ action: "commands" as const, repo: key, session, output: deps.trimBlock(cleaned, 8000) }, "low");
}

export async function reviewSession(
  config: any,
  repo: string,
  deps: {
    requireInteractiveSession: typeof requireInteractiveSession,
    runTmux: (args: string[], timeoutSec?: number) => Promise<any>,
    interactiveResult: typeof interactiveResult,
    resolveRepo: any,
    tmuxSessionName: any,
    tmuxSessionExists: any,
    isAgentAlive: any,
  },
) {
  const { key, session } = await deps.requireInteractiveSession(config, repo, deps.resolveRepo, deps.tmuxSessionName, deps.tmuxSessionExists, deps.isAgentAlive);
  await deps.runTmux(["send-keys", "-t", session, "C-r"], 10);
  return deps.interactiveResult({ action: "review" as const, repo: key, session }, "low");
}
