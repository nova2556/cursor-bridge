import {
  normalizeConfig,
  parseCommandArgs,
  buildStatus,
  listSessions,
  startAgent,
  sendToAgent,
  tailAgent,
  stopAgent,
  openRepo,
  listHistory,
  listModels,
  resumeAgent,
  waitForAgent,
  runOneShot,
  compressSession,
  mcpControl,
  isAgentAlive,
  addContext,
  showRules,
  showCommands,
  reviewSession,
  quitSession,
  linuxToWindowsPath,
  isTransientAgentError,
  compileTaskSpec,
  collectTaskSignals,
  inferMilestoneStatus,
  synthesizeTaskSummary,
  runTask,
} from './index.ts';
import { stripCommandEchoNoise, cleanOneShotOutput, extractLastAssistantAnswer, paneLooksBusy, paneShowsInputPrompt } from './heuristics.ts';
import { preferStreamOutput, buildInteractiveOutput } from './interactive-runtime.ts';
import { interactiveMeta, interactiveResult } from './interactive-actions.ts';
import fs from 'node:fs';
import path from 'node:path';

const configPath = process.argv[2] || path.join(process.env.HOME || '', '.openclaw/openclaw.json');
const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const pluginRaw = raw?.plugins?.entries?.['cursor-bridge']?.config || {};
const config = normalizeConfig(pluginRaw);

const repo = process.argv[3] || Object.keys(config.repos)[0];
if (!repo) {
  console.error('No repo configured for cursor-bridge.');
  process.exit(2);
}

const { cwd } = (() => {
  const repoPath = config.repos[repo];
  if (!repoPath) { console.error(`Repo not found: ${repo}`); process.exit(2); }
  return { cwd: path.resolve(repoPath) };
})();

const results = [];
const runIntegration = process.env.CURSOR_BRIDGE_SELFTEST_INTEGRATION === '1';

async function step(name, fn) {
  process.stderr.write(`  running: ${name}\n`);
  try {
    const details = await fn();
    results.push({ name, ok: true, details });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// ─── Phase 1: command parsing ────────────────────────────────────────────────

await step('parse: status / repos / sessions / help / login / update', async () => ({
  status:   parseCommandArgs('status'),
  repos:    parseCommandArgs('repos'),
  sessions: parseCommandArgs('sessions'),
  help:     parseCommandArgs('help'),
  login:    parseCommandArgs('login'),
  update:   parseCommandArgs('update'),
}));

await step('parse: open / start / stop / quit', async () => ({
  open:            parseCommandArgs(`open ${repo}`),
  start:           parseCommandArgs(`start ${repo}`),
  startModel:      parseCommandArgs(`start ${repo} model=sonnet-4.6`),
  startPrompt:     parseCommandArgs(`start ${repo} :: 先分析项目结构`),
  startPromptModel:parseCommandArgs(`start ${repo} :: 先分析项目结构 model=sonnet-4.6`),
  stop:            parseCommandArgs(`stop ${repo}`),
  quit:            parseCommandArgs(`quit ${repo}`),
}));

await step('parse: send', async () => ({
  send:        parseCommandArgs(`send ${repo} :: hello from selftest`),
  sendMissing: parseCommandArgs(`send ${repo}`),
}));

await step('parse: tail / wait', async () => ({
  tail:        parseCommandArgs(`tail ${repo} 120`),
  tailDefault: parseCommandArgs(`tail ${repo}`),
  wait:        parseCommandArgs(`wait ${repo} 60`),
  waitDefault: parseCommandArgs(`wait ${repo}`),
}));

await step('parse: history / models / model', async () => ({
  history:    parseCommandArgs(`history ${repo}`),
  models:     parseCommandArgs(`models ${repo}`),
  modelOpen:  parseCommandArgs(`model ${repo}`),
  modelSet:   parseCommandArgs(`model ${repo} :: sonnet-4.6`),
}));

await step('parse: resume', async () => ({
  resumeLatest: parseCommandArgs(`resume ${repo}`),
  resumeId:     parseCommandArgs(`resume ${repo} :: abc123`),
  resumeModel:  parseCommandArgs(`resume ${repo} :: abc123 model=gpt-5`),
}));

await step('parse: run (text / json / stream-json)', async () => ({
  runBasic:      parseCommandArgs(`run ${repo} :: fix the bug`),
  runJson:       parseCommandArgs(`run ${repo} :: audit format=json wait=300`),
  runStreamJson: parseCommandArgs(`run ${repo} :: stream it format=stream-json`),
  runModel:      parseCommandArgs(`run ${repo} :: check it model=gpt-5 format=text`),
  runBad:        parseCommandArgs(`run ${repo}`),
}));

await step('parse: task', async () => ({
  taskBasic: parseCommandArgs(`task ${repo} :: fix login flow`),
  taskRich: parseCommandArgs(`task ${repo} :: fix login flow mode=auto resume=auto model=gpt-5 wait=300 format=text context=README.md,src deliverable=Ship patch and summarize`),
  taskRichQuoted: parseCommandArgs(`task ${repo} :: fix login flow for mobile mode=interactive resume=resume-recent model=gpt-5 wait=420 format=json context=README.md,src deliverable="Ship patch and summarize clearly"`),
  taskGoalKeepsInlineWords: parseCommandArgs(`task ${repo} :: fix mode switch bug in auth panel mode=interactive wait=240`),
}));

await step('compileTaskSpec utility', async () => {
  const spec = compileTaskSpec(config, 'Implement feature and validate it', {
    mode: 'auto',
    resume: 'auto',
    outputFormat: 'text',
    contextPaths: ['README.md', 'src'],
    deliverable: 'Ship patch and summarize',
  });
  return {
    mode: spec.mode,
    resume: spec.resume,
    milestones: spec.milestones,
    context: spec.initialContextPaths,
    deliverable: spec.deliverable,
  };
});

await step('task auto policy metadata assumptions', async () => ({
  taskPreferInteractiveDefault: config.taskPreferInteractive,
  autoModeExpectedLane: config.taskPreferInteractive ? 'interactive-emulated' : 'stable-cli',
}));

await step('task signal extraction + summary synthesis', async () => {
  const spec = compileTaskSpec(config, 'Fix auth regression and validate it', {
    outputFormat: 'text',
    deliverable: 'Ship patch and summarize',
  });
  const sampleOutput = [
    'Outcome: Completed the auth regression fix.',
    'Updated src/auth/login.ts and added a guard for missing sessions.',
    'Validation: npm test -- auth passed.',
    'Blocker: waiting on approval to rotate the production secret.',
    'Risk: production secret still needs manual rotation.',
  ].join('\n');
  const signals = collectTaskSignals(sampleOutput);
  const milestoneStatus = inferMilestoneStatus(spec.milestones, sampleOutput);
  const state = {
    repo,
    mode: 'interactive',
    phase: 'done',
    milestoneStatus,
    assumptions: spec.assumptions,
    constraints: spec.constraints,
    successCriteria: spec.successCriteria,
    rawOutput: sampleOutput,
    output: sampleOutput,
    signals,
    blockerSummary: signals.find((item) => item.kind === 'blocker')?.text,
    approvalSummary: signals.find((item) => item.kind === 'approval')?.text,
    decision: { mode: 'interactive', policy: 'reused live session for continuity', sessionStrategy: 'reuse-live', lane: 'interactive-emulated', reliability: 'medium', liveSession: 'cursor-test' },
  };
  const summary = synthesizeTaskSummary(spec, state);
  const details = {
    signalKinds: signals.map((item) => item.kind),
    blockedMilestones: milestoneStatus.filter((item) => item.status === 'blocked').length,
    summary,
  };
  if (!signals.some((item) => item.kind === 'validation') || !signals.some((item) => item.kind === 'blocker') || !summary.includes('Task report:') || !summary.includes('Risks / follow-ups:')) {
    throw new Error(`Task synthesis mismatch: ${JSON.stringify(details)}`);
  }
  return details;
});

await step('parse: compress / context / rules / commands / review', async () => ({
  compress: parseCommandArgs(`compress ${repo}`),
  context:  parseCommandArgs(`context ${repo} :: src/components/Login.tsx`),
  contextAt:parseCommandArgs(`context ${repo} :: @src/components/Login.tsx`),
  rules:    parseCommandArgs(`rules ${repo}`),
  commands: parseCommandArgs(`commands ${repo}`),
  review:   parseCommandArgs(`review ${repo}`),
}));

await step('parse: mcp', async () => ({
  mcpEnable:  parseCommandArgs(`mcp ${repo} :: enable my-server`),
  mcpDisable: parseCommandArgs(`mcp ${repo} :: disable old-server`),
  mcpBad:     parseCommandArgs(`mcp ${repo}`),
}));

await step('parse: error cases', async () => ({
  unknown:       parseCommandArgs(`unknown ${repo}`),
  emptyArgs:     parseCommandArgs(''),
  sendNoRepo:    parseCommandArgs('send'),
  contextNoPath: parseCommandArgs(`context ${repo}`),
}));

await step('linuxToWindowsPath utility', async () => ({
  wslPath:      linuxToWindowsPath('/mnt/e/voxa/web_v1'),
  wslRootPath:  linuxToWindowsPath('/mnt/c'),
  linuxNative:  linuxToWindowsPath('/home/rog/project'),
  unchanged:    linuxToWindowsPath('relative/path'),
}));

await step('transient error detector', async () => {
  const details = {
    etimedout: isTransientAgentError('request failed: ETIMEDOUT while connecting'),
    tls:       isTransientAgentError('TLS handshake failed: Client network socket disconnected before secure TLS connection was established'),
    socket:    isTransientAgentError('socket hang up during resume'),
    benign:    isTransientAgentError('validation failed: unknown repo alias'),
  };
  if (!details.etimedout || !details.tls || !details.socket || details.benign) {
    throw new Error(`Transient detector mismatch: ${JSON.stringify(details)}`);
  }
  return details;
});

await step('noise cleaning keeps useful command content', async () => {
  const noisy = [
    'rog@host:~$ /cursor commands web_v1',
    "'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoLogo -NoProfile -EncodedCommand ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ",
    'Cursor Agent v1.2.3',
    ' /commands',
    '/add-context - Attach files',
    '/review - Review current changes',
    '/mcp enable foo - Enable MCP server',
    '/ commands · @ files · ! shell',
  ].join('\n');
  const cleaned = stripCommandEchoNoise(noisy);
  const oneShot = cleanOneShotOutput(`#< CLIXML\n${noisy}\n<Objs Version=\"1.1.0.1\"></Objs>`);
  const details = {
    cleaned,
    keptCommands: cleaned.includes('/add-context') && cleaned.includes('/review') && cleaned.includes('/mcp enable foo'),
    removedEcho: !cleaned.includes('rog@host') && !cleaned.includes('Cursor Agent v1.2.3') && !cleaned.includes('/ commands · @ files · ! shell'),
    oneShotCleaned: oneShot,
  };
  if (!details.keptCommands || !details.removedEcho) {
    throw new Error(`Noise cleaning mismatch: ${JSON.stringify(details)}`);
  }
  return details;
});

await step('prompt heuristics cleaning behavior', async () => {
  const sample = [
    'Working',
    'Read 3 files',
    'Updated src/auth.ts',
    '>',
  ].join('\n');
  const cleaned = stripCommandEchoNoise(sample);
  const oneShot = cleanOneShotOutput('#< CLIXML\nCursor Agent v1.2.3\nOutcome: ok\n<Objs></Objs>');
  const assistantAnswer = extractLastAssistantAnswer(['you: fix it', 'Updated src/auth.ts', '>'].join('\n'));
  const busy = paneLooksBusy('Thinking...');
  const promptVisible = paneShowsInputPrompt('Add a follow-up\n>');
  const preferred = preferStreamOutput('stream output', 'pane output', true);
  const built = buildInteractiveOutput({
    pane: 'pane output',
    scopedPane: 'scoped pane output',
    busy: false,
    promptVisible: true,
    answer: 'assistant answer',
    answerVisible: true,
    streamDelta: 'live delta',
    streamTailText: 'tail text',
    logPath: '/tmp/demo.log',
    streamBytes: 42,
  });
  return {
    cleaned,
    oneShot,
    hasOutcome: oneShot.includes('Outcome: ok'),
    assistantAnswer,
    busy,
    promptVisible,
    preferred,
    built,
  };
});

await step('parse: repo:subdir syntax', async () => ({
  repoSubdir:      parseCommandArgs(`start ${repo}:backend`),
  repoSubdirModel: parseCommandArgs(`start ${repo}:frontend model=gpt-5`),
  historySubdir:   parseCommandArgs(`history ${repo}:api`),
  runSubdir:       parseCommandArgs(`run ${repo}:workers :: check logs`),
}));

// ─── Phase 2: infrastructure / integration (opt-in) ─────────────────────────

if (runIntegration) {

await step('status', async () => {
  const status = await buildStatus(config);
  return {
    prereqsOk:      status.prereqs.ok,
    prereqProblems: status.prereqs.problems,
    repoCount:      status.repoChecks.length,
    activeSessions: status.sessions.length,
    summaryLength:  status.text.length,
  };
});

await step('repos listing', async () => Object.entries(config.repos).map(([k, v]) => ({ key: k, cwd: path.resolve(v) })));

await step('sessions listing (before any start)', async () => await listSessions(config));

// ─── Phase 3: non-interactive CLI queries ─────────────────────────────────────

await step('history (agent ls via tmux)', async () => {
  const result = await listHistory(config, cwd);
  return { outputLength: result.output.length, preview: result.output.slice(0, 300) };
});

await step('models (agent --list-models)', async () => {
  const result = await listModels(config, cwd);
  return { outputLength: result.output.length, preview: result.output.slice(0, 200) };
});

// ─── Phase 4: interactive session lifecycle ───────────────────────────────────

await step('start session (no initial prompt)', async () => {
  const result = await startAgent(config, repo);
  return { reused: result.reused, session: result.session, launch: result.launch };
});

await step('sessions listing (after start)', async () => await listSessions(config));

await step('isAgentAlive (after start)', async () => {
  const sessionName = `${config.tmuxPrefix}-${repo.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
  const alive = await isAgentAlive(sessionName);
  return { sessionName, alive };
});

await step('send instruction', async () => {
  return await sendToAgent(config, repo, 'Please reply with exactly: CURSOR_BRIDGE_OK. Do not modify files.');
});

await step('wait for agent response (up to 60s)', async () => {
  const result = await waitForAgent(config, repo, 60);
  return {
    timedOut:     result.timedOut,
    outputLength: result.output.length,
    acknowledged: result.output.includes('CURSOR_BRIDGE_OK'),
  };
});

await step('tail output (120 lines)', async () => {
  const result = await tailAgent(config, repo, 120);
  return {
    lines:        result.lines,
    outputLength: result.output.length,
    acknowledged: result.output.includes('CURSOR_BRIDGE_OK'),
  };
});

await step('compress (send /compress)', async () => {
  return await compressSession(config, repo);
});

await step('rules (send /rules)', async () => {
  return await showRules(config, repo);
});

await step('commands (send /commands)', async () => {
  return await showCommands(config, repo);
});

await step('review (send Ctrl+R)', async () => {
  return await reviewSession(config, repo);
});

await step('mcp enable test-server (send /mcp enable)', async () => {
  return await mcpControl(config, repo, 'enable', 'test-server');
});

await step('context attach (send @README.md)', async () => {
  return await addContext(config, repo, 'README.md');
});

await step('quit session (graceful)', async () => {
  return await quitSession(config, repo);
});

await step('sessions listing (after quit)', async () => await listSessions(config));

// ─── Phase 5: start with initialPrompt ───────────────────────────────────────

await step('start session (with initialPrompt)', async () => {
  const result = await startAgent(
    config,
    repo,
    undefined,
    'Please reply with exactly: CURSOR_BRIDGE_INIT_OK. Do not modify files.',
  );
  return { reused: result.reused, session: result.session };
});

await step('wait for initialPrompt response (up to 60s)', async () => {
  const result = await waitForAgent(config, repo, 60);
  return {
    timedOut:     result.timedOut,
    acknowledged: result.output.includes('CURSOR_BRIDGE_INIT_OK'),
  };
});

await step('stop session (after initialPrompt test)', async () => {
  return await stopAgent(config, repo);
});

// ─── Phase 6: resume ──────────────────────────────────────────────────────────

await step('resume latest (no chat-id)', async () => {
  // Resume most recent — may fail if no history exists, that is expected
  return await resumeAgent(config, repo, '');
});

await step('send after resume', async () => {
  return await sendToAgent(config, repo, 'Please reply with exactly: CURSOR_BRIDGE_RESUME_OK. Do not modify files.');
});

await step('wait for resume response (up to 60s)', async () => {
  const result = await waitForAgent(config, repo, 60);
  return {
    timedOut:     result.timedOut,
    acknowledged: result.output.includes('CURSOR_BRIDGE_RESUME_OK'),
  };
});

await step('stop resumed session', async () => {
  return await stopAgent(config, repo);
});

// ─── Phase 7: one-shot run ────────────────────────────────────────────────────

await step('run one-shot (text output, 60s)', async () => {
  const result = await runOneShot(
    config,
    repo,
    'Please reply with exactly: CURSOR_BRIDGE_ONESHOT_OK. Do not modify files.',
    60,
    undefined,
    'text',
  );
  return {
    timedOut:     result.timedOut,
    outputLength: result.output.length,
    acknowledged: result.output.includes('CURSOR_BRIDGE_ONESHOT_OK'),
  };
});

await step('task orchestration (oneshot mode, 90s)', async () => {
  const result = await runTask(config, repo, 'Please reply with exactly: CURSOR_BRIDGE_TASK_OK. Do not modify files.', {
    mode: 'oneshot',
    waitSec: 90,
    outputFormat: 'text',
    deliverable: 'Return the exact marker and a concise summary.',
  });
  return {
    phase: result.state.phase,
    mode: result.state.mode,
    summaryLength: result.state.summary.length,
    acknowledged: (result.state.output || '').includes('CURSOR_BRIDGE_TASK_OK'),
  };
});

// ─── Phase 8: GUI open (optional, set CURSOR_BRIDGE_SELFTEST_OPEN=1 to enable) ───

await step('open GUI command (optional — skipped by default)', async () => {
  if (!process.env.CURSOR_BRIDGE_SELFTEST_OPEN) {
    return { skipped: true, reason: 'Set CURSOR_BRIDGE_SELFTEST_OPEN=1 to run this step' };
  }
  return await openRepo(config, repo);
});

} else {
  await step('integration phases skipped', async () => ({
    skipped: true,
    reason: 'Set CURSOR_BRIDGE_SELFTEST_INTEGRATION=1 to run tmux/Cursor integration phases',
  }));
}

// ─── Results ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok).length;
const passed = results.length - failed;

const summary = {
  configPath,
  repo,
  cwd,
  defaultModel: config.defaultModel,
  apiKeySet: !!config.apiKey,
  agentWindowsBin: config.agentWindowsBin || '(not set)',
  failed,
  passed,
  total: results.length,
  results,
};

console.log(JSON.stringify(summary, null, 2));

if (failed > 0) {
  process.stderr.write(`\n${failed}/${results.length} steps failed.\n`);
  process.exit(1);
} else {
  process.stderr.write(`\nAll ${results.length} steps passed.\n`);
}
