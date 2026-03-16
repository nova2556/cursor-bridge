import { cleanStreamText, extractLastAssistantAnswer, isMostlyUiChromeLine, stripCommandEchoNoise } from "./heuristics.ts";

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values.map((v) => v.trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function inferTaskMilestones(goal: string, maxCount: number): string[] {
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

export function compileTaskSpec(config: any, goal: string, options?: any) {
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

export function buildTaskPrompt(spec: any): string {
  const parts = [
    `Task goal: ${spec.goal}`,
    `Deliverable: ${spec.deliverable}`,
    spec.assumptions.length ? `Operating assumptions:\n${spec.assumptions.map((item: string, idx: number) => `${idx + 1}. ${item}`).join("\n")}` : "",
    spec.constraints.length ? `Constraints:\n${spec.constraints.map((item: string, idx: number) => `${idx + 1}. ${item}`).join("\n")}` : "",
    spec.milestones.length ? `Milestones to work through:\n${spec.milestones.map((item: string, idx: number) => `${idx + 1}. ${item}`).join("\n")}` : "",
    spec.successCriteria.length ? `Success criteria:\n${spec.successCriteria.map((item: string, idx: number) => `${idx + 1}. ${item}`).join("\n")}` : "",
    spec.hooks.assumptionsPrompt ? `Additional task assumptions prompt: ${spec.hooks.assumptionsPrompt}` : "",
    "Execution style: work autonomously, make pragmatic decisions, and report progress by milestone rather than constant chatter.",
    "Final response format:\n- Outcome\n- Milestones\n- Changes / findings\n- Validation\n- Risks / follow-ups",
  ].filter(Boolean);
  if (spec.hooks.preTaskPrompt) parts.unshift(spec.hooks.preTaskPrompt);
  if (spec.hooks.postTaskPrompt) parts.push(spec.hooks.postTaskPrompt);
  return parts.join("\n\n");
}

export async function chooseTaskSession(config: any, repo: string, spec: any, deps: any) {
  if (spec.mode === "oneshot") {
    return { mode: "oneshot", policy: "explicit oneshot mode", sessionStrategy: "oneshot", lane: "stable-cli", reliability: "high" };
  }
  if (spec.mode === "interactive") {
    const { key, cwd } = deps.resolveRepo(config, repo);
    const session = deps.tmuxSessionName(config, key);
    if ((spec.resume === "auto" || spec.resume === "reuse-live") && await deps.tmuxSessionExists(session) && await deps.isAgentAlive(session)) {
      return { mode: "interactive", policy: "explicit interactive mode reused live session for continuity", sessionStrategy: "reuse-live", lane: "interactive-emulated", reliability: "medium", liveSession: session };
    }
    if (spec.resume !== "fresh") {
      const history = await deps.listHistory(config, cwd).catch(() => ({ entries: [], output: "" }));
      const recentEntries = history.entries.slice(0, config.taskRecentHistoryLimit);
      if (recentEntries.length && (spec.resume === "auto" || spec.resume === "resume-recent")) {
        return { mode: "interactive", policy: `explicit interactive mode resumed recent stored conversation (${recentEntries[0]?.id ?? "latest"})`, sessionStrategy: "resume-recent", lane: "interactive-emulated", reliability: "medium", resumedChatId: recentEntries[0]?.id, historyCount: recentEntries.length };
      }
    }
    return { mode: "interactive", policy: "explicit interactive mode started a fresh interactive session", sessionStrategy: "fresh-start", lane: "interactive-emulated", reliability: "medium" };
  }
  if (!config.taskPreferInteractive) {
    return { mode: "oneshot", policy: "auto mode prefers stable one-shot CLI execution", sessionStrategy: "oneshot", lane: "stable-cli", reliability: "high" };
  }
  const { key, cwd } = deps.resolveRepo(config, repo);
  const session = deps.tmuxSessionName(config, key);
  if ((spec.resume === "auto" || spec.resume === "reuse-live") && await deps.tmuxSessionExists(session) && await deps.isAgentAlive(session)) {
    return { mode: "interactive", policy: "auto mode reused live session for continuity", sessionStrategy: "reuse-live", lane: "interactive-emulated", reliability: "medium", liveSession: session };
  }
  if (spec.resume !== "fresh") {
    const history = await deps.listHistory(config, cwd).catch(() => ({ entries: [], output: "" }));
    const recentEntries = history.entries.slice(0, config.taskRecentHistoryLimit);
    if (recentEntries.length && (spec.resume === "auto" || spec.resume === "resume-recent")) {
      return { mode: "interactive", policy: `auto mode resumed recent stored conversation (${recentEntries[0]?.id ?? "latest"})`, sessionStrategy: "resume-recent", lane: "interactive-emulated", reliability: "medium", resumedChatId: recentEntries[0]?.id, historyCount: recentEntries.length };
    }
  }
  return { mode: "interactive", policy: "auto mode started a fresh interactive session", sessionStrategy: "fresh-start", lane: "interactive-emulated", reliability: "medium" };
}

export function taskOutputLines(output: string): string[] {
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

export function collectTaskSignals(output: string) {
  const signals: any[] = [];
  for (const line of taskOutputLines(output)) {
    const lower = line.toLowerCase();
    const clean = line.replace(/^[-*•\d.)\s]+/, "").trim();
    if (!clean) continue;
    const push = (kind: string, severity = "info") => { signals.push({ kind, severity, text: clean }); };
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
    return { kind, severity, text: rest.join("|") };
  });
}

export function findTaskSummaryLine(lines: string[], pattern: RegExp): string | undefined {
  return lines.find((line) => pattern.test(line));
}

export function normalizeTaskInteractiveOutput(raw: string): string {
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

export function inferMilestoneStatus(milestones: string[], output: string) {
  return milestones.map((title) => {
    const keywords = uniqueStrings(title.toLowerCase().split(/[^a-z0-9]+/i).filter((token) => token.length > 3)).slice(0, 4);
    const matchingLines = taskOutputLines(output).filter((line) => keywords.some((token) => line.toLowerCase().includes(token)));
    const blocked = matchingLines.some((line) => /\b(blocked|blocker|waiting on|cannot continue|can't continue|needs approval|requires approval)\b/i.test(line));
    const done = matchingLines.some((line) => /\b(done|completed|finished|implemented|updated|validated|verified|tested|created|wrote|fixed)\b/i.test(line));
    return { title, status: blocked ? "blocked" : done ? "inferred_done" : "pending" };
  });
}

export async function maybeAdvanceInteractiveTask(config: any, repo: string, spec: any, firstWait: any, deps: any) {
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
  await deps.sendToAgent(config, repo, continuationPrompt);
  const secondWait = await deps.waitForAgent(config, repo, Math.max(45, Math.min(600, Math.floor(spec.waitSec / 2))));
  const combinedOutput = [firstOutput, secondWait.output || secondWait.rawOutput || ""].filter(Boolean).join("\n\n").trim();
  return { finalWait: secondWait, combinedOutput, signals: collectTaskSignals(combinedOutput), continuationPrompt };
}

export function synthesizeTaskSummary(spec: any, state: any): string {
  const lines = taskOutputLines(state.output || state.rawOutput || "");
  const outcome = findTaskSummaryLine(lines, /\b(outcome|result|completed|finished|shipped|fixed|implemented|blocked|timed out)\b/i)
    || state.blockerSummary
    || state.approvalSummary
    || lines.at(-1)
    || lines[0]
    || (state.phase === "timed_out" ? "Timed out before the agent produced a stable final answer." : "Completed without a concise final line from the agent.");
  const completedCount = state.milestoneStatus.filter((item: any) => item.status === "inferred_done").length;
  const blockedCount = state.milestoneStatus.filter((item: any) => item.status === "blocked").length;
  const milestoneLine = state.milestoneStatus.map((item: any, idx: number) => `${idx + 1}. ${item.title} — ${item.status === "inferred_done" ? "done" : item.status === "blocked" ? "blocked" : "pending"}`).join("\n");
  const changes = state.signals.filter((item: any) => item.kind === "change" || item.kind === "milestone").map((item: any) => item.text).slice(0, 4);
  const validations = state.signals.filter((item: any) => item.kind === "validation").map((item: any) => item.text).slice(0, 3);
  const risks = uniqueStrings([
    ...(state.blockerSummary ? [state.blockerSummary] : []),
    ...(state.approvalSummary ? [state.approvalSummary] : []),
    ...state.signals.filter((item: any) => item.kind === "blocker" || item.kind === "approval" || item.kind === "risk").map((item: any) => item.text),
  ]).slice(0, 4);
  return [
    `Task report: ${spec.goal}`,
    `Outcome: ${outcome}`,
    `Execution: ${state.mode} via ${state.decision.sessionStrategy} (${state.decision.policy})`,
    `Lane: ${state.decision.lane} / reliability=${state.decision.reliability}`,
    `Progress: ${completedCount}/${state.milestoneStatus.length} milestones inferred done${blockedCount ? `, ${blockedCount} blocked` : ""}`,
    milestoneLine ? `Milestones:\n${milestoneLine}` : "",
    changes.length ? `Changes / findings:\n${changes.map((line: string) => `- ${line}`).join("\n")}` : "",
    validations.length ? `Validation:\n${validations.map((line: string) => `- ${line}`).join("\n")}` : "",
    risks.length ? `Risks / follow-ups:\n${risks.map((line: string) => `- ${line}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function runTask(config: { [key: string]: any }, repo: string, goal: string, options: any, deps: TaskOrchestratorDeps) {
  const spec = compileTaskSpec(config, goal, options);
  const decision = await chooseTaskSession(config, repo, spec, deps);
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
    signals: [] as any[],
    blockerSummary: undefined as string | undefined,
    approvalSummary: undefined as string | undefined,
    decision,
  };

  if (decision.mode === "oneshot") {
    const result = await deps.runOneShot(config, repo, prompt, spec.waitSec, spec.model, spec.outputFormat);
    const phase = result.timedOut ? "timed_out" : "done";
    const combinedOutput = result.output || result.rawOutput || "";
    const signals = collectTaskSignals(combinedOutput);
    const stateNoSummary = {
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
    return { action: "task" as const, repo, spec, state: { ...stateNoSummary, summary }, result, ...deps.stableCliMeta("high") };
  }

  let sessionResult;
  if (decision.sessionStrategy === "reuse-live") {
    sessionResult = { repo, cwd: deps.resolveRepo(config, repo).cwd, session: decision.liveSession, reused: true };
  } else if (decision.sessionStrategy === "resume-recent") {
    sessionResult = await deps.resumeAgent(config, repo, decision.resumedChatId ?? "", spec.model);
  } else {
    sessionResult = await deps.startAgent(config, repo, spec.model);
  }
  for (const contextPath of spec.initialContextPaths) {
    await deps.addContext(config, repo, contextPath);
  }
  await deps.sendToAgent(config, repo, prompt);
  const firstWait = await deps.waitForAgent(config, repo, spec.waitSec);
  const advanced = await maybeAdvanceInteractiveTask(config, repo, spec, firstWait, deps);
  const waited = advanced.finalWait;
  const combinedOutput = advanced.combinedOutput || waited.output || waited.rawOutput || "";
  const cleanedInteractiveOutput = deps.trimBlock(
    normalizeTaskInteractiveOutput(combinedOutput)
      || extractLastAssistantAnswer(combinedOutput)
      || cleanStreamText(combinedOutput)
      || stripCommandEchoNoise(combinedOutput)
      || combinedOutput,
    16000,
  );
  const signals = advanced.signals.length ? advanced.signals : collectTaskSignals(cleanedInteractiveOutput);
  const phase = waited.timedOut ? "timed_out" : "done";
  const stateNoSummary = {
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
    ...deps.interactiveMeta("medium"),
  };
}
