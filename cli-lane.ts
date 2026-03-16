import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanOneShotOutput } from "./heuristics.ts";

export function parseHistoryOutput(raw: string): Array<{ id: string; title: string; raw: string }> {
  const entries: Array<{ id: string; title: string; raw: string }> = [];
  const uuidPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(uuidPattern);
    if (!match) continue;
    const id = match[1];
    const title = line.slice(line.indexOf(id) + id.length).replace(/\s+/g, " ").trim() || "(no title)";
    entries.push({ id, title, raw: line.trim() });
  }
  return entries;
}

export async function listHistory(config: any, cwd: string, deps: any) {
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const lsSession = `${config.tmuxPrefix}-ls-${Date.now()}`;
  const gitWrapperWindowsPath = await deps.ensureGitWrapper(config);
  const launch = deps.buildAgentLaunch(config, cwd, undefined, gitWrapperWindowsPath, " ls");
  const lsCommand = launch.command;
  try {
    await deps.runTmux(["new-session", "-d", "-s", lsSession, "-c", cwd], 20);
    await deps.sleep(config.startDelaySec * 1000);
    await deps.runTmux(["send-keys", "-t", lsSession, "-l", "--", lsCommand], 10);
    await deps.runTmux(["send-keys", "-t", lsSession, "Enter"], 10);
    let output = "";
    for (let i = 0; i < 6; i++) {
      await deps.sleep(1000);
      const { stdout } = await deps.runTmux(["capture-pane", "-t", lsSession, "-p", "-S", "-60"], 10).catch(() => ({ stdout: "" }));
      output = stdout;
      if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(output) || /no conversations|empty|no chats/i.test(output)) break;
    }
    const entries = parseHistoryOutput(output);
    return { action: "history" as const, entries, output: deps.trimBlock(output, 12000), ...deps.interactiveMeta("low") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: "history" as const, entries: [], output: `(agent ls failed: ${message})`, ...deps.interactiveMeta("low") };
  } finally {
    await deps.runTmux(["kill-session", "-t", lsSession], 10).catch(() => {});
  }
}

export async function listModels(config: any, cwd: string, deps: any) {
  try {
    if (config.agentWindowsBin) {
      const ps = deps.getWindowsPowerShellPath();
      const windowsCwd = deps.linuxToWindowsPath(cwd);
      const inner = `${config.apiKey ? `$env:CURSOR_API_KEY=${deps.quotePsh(config.apiKey)}; ` : ""}${windowsCwd !== cwd ? `Set-Location ${deps.quotePsh(windowsCwd)}; ` : ""}& ${deps.quotePsh(config.agentWindowsBin)} --list-models`;
      const { stdout, stderr } = await deps.runQuick(ps, ["-NoLogo", "-NoProfile", "-Command", inner], cwd, config.timeoutSec, config.apiKey);
      return { action: "models" as const, output: deps.trimBlock(stdout || stderr, 12000), ...deps.stableCliMeta("high") };
    }
    const command = config.agentCommand
      ? `${config.agentCommand} --list-models`
      : `${deps.quoteSh(config.agentBinary)} --list-models`;
    const { stdout, stderr } = await deps.runShell(command, cwd, config.timeoutSec, config.apiKey);
    return { action: "models" as const, output: deps.trimBlock(stdout || stderr, 12000), ...deps.stableCliMeta("high") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: "models" as const, output: `(agent --list-models failed: ${message})`, ...deps.stableCliMeta("high") };
  }
}

export async function runOneShot(config: any, repo: string, text: string, waitSec = 120, model: string | undefined, outputFormat: "text" | "json" | "stream-json", deps: any) {
  if (!config.enabled) throw new Error("cursor-bridge is disabled in plugin config");
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const { key, cwd } = deps.resolveRepo(config, repo);
  if (!(await deps.pathExists(cwd))) throw new Error(`Configured repo path does not exist: ${cwd}`);
  const baseSession = deps.tmuxSessionName(config, key);
  const gitWrapperWindowsPath = await deps.ensureGitWrapper(config);
  const formatFlag = ` --output-format ${outputFormat}`;
  const streamFlag = outputFormat === "stream-json" ? " --stream-partial-output" : "";
  const extraArgs = ` -p ${deps.quotePsh(text)}${formatFlag}${streamFlag} --force`;
  const launch = deps.buildAgentLaunch(config, cwd, model, gitWrapperWindowsPath, extraArgs);

  const runOnce = async (attempt: number) => {
    const runSession = `${baseSession}-run-${Date.now()}-${attempt}`;
    const tmpFile = path.join(tmpdir(), `cursor-run-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
    const oneShotCommand = `${launch.command} > ${deps.quoteSh(tmpFile)} 2>&1`;
    try {
      await deps.runTmux(["new-session", "-d", "-s", runSession, "-c", cwd], 20);
      await deps.sleep(config.startDelaySec * 1000);
      await deps.runTmux(["send-keys", "-t", runSession, "-l", "--", oneShotCommand], 10);
      await deps.runTmux(["send-keys", "-t", runSession, "Enter"], 10);
      const deadline = Date.now() + Math.max(10, Math.min(600, waitSec)) * 1000;
      const pollMs = 3000;
      let idleRounds = 0;
      let completed = false;
      const donePattern = /[$%#>]\s*$/m;
      while (Date.now() < deadline) {
        await deps.sleep(pollMs);
        const { stdout: pane } = await deps.runTmux(["capture-pane", "-t", runSession, "-p", "-S", "-10"], 10).catch(() => ({ stdout: "" }));
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
        const { stdout: pane } = await deps.runTmux(["capture-pane", "-t", runSession, "-p", "-S", "-200"], 10).catch(() => ({ stdout: "" }));
        output = pane;
      }
      if ((timedOut || !cleanOneShotOutput(output)) && attempt < 2 && deps.isTransientAgentError(output)) {
        throw new Error(`Transient one-shot agent failure detected:\n${deps.trimBlock(output, 3000)}`);
      }
      const cleanedOutput = cleanOneShotOutput(output);
      return {
        action: "run" as const,
        repo: key,
        cwd,
        prompt: text,
        timedOut,
        output: deps.trimBlock(cleanedOutput || output, 16000),
        rawOutput: deps.trimBlock(output, 16000),
        ...deps.stableCliMeta("high"),
      };
    } finally {
      await unlink(tmpFile).catch(() => {});
      await deps.runTmux(["kill-session", "-t", runSession], 10).catch(() => {});
    }
  };

  return deps.maybeRetryAgentLaunch("run", `${baseSession}-run`, 1, async () => runOnce(1)).catch(async (firstErr: any) => {
    if (!deps.isTransientAgentError(firstErr instanceof Error ? firstErr.message : String(firstErr))) throw firstErr;
    await deps.sleep(1200);
    return runOnce(2);
  });
}

export async function loginAgent(config: any, deps: any) {
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const loginSession = `${config.tmuxPrefix}-login-${Date.now()}`;
  const base = config.agentCommand ? config.agentCommand : deps.quoteSh(config.agentBinary);
  const envPrefix = config.apiKey ? `CURSOR_API_KEY=${deps.quoteSh(config.apiKey)} ` : "";
  const loginCommand = `${envPrefix}${base} login`;
  await deps.runTmux(["new-session", "-d", "-s", loginSession], 20);
  await deps.sleep(config.startDelaySec * 1000);
  await deps.runTmux(["send-keys", "-t", loginSession, "-l", "--", loginCommand], 10);
  await deps.runTmux(["send-keys", "-t", loginSession, "Enter"], 10);
  await deps.sleep(4000);
  const { stdout } = await deps.runTmux(["capture-pane", "-t", loginSession, "-p", "-S", "-30"], 10).catch(() => ({ stdout: "" }));
  return { action: "login" as const, session: loginSession, output: deps.trimBlock(stdout, 4000) };
}

export async function updateAgent(config: any, deps: any) {
  if (!config.allowAgent) throw new Error("agent mode is disabled. Set allowAgent=true to enable Cursor agent sessions.");
  const base = config.agentCommand ? config.agentCommand : deps.quoteSh(config.agentBinary);
  const updateCommand = `${base} update`;
  try {
    const { stdout, stderr } = await deps.runShell(updateCommand, process.cwd(), Math.max(config.timeoutSec, 60), config.apiKey);
    return { action: "update" as const, output: deps.trimBlock(stdout || stderr, 8000) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: "update" as const, output: `(agent update failed: ${message})` };
  }
}
