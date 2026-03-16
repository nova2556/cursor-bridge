import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanStreamText, extractLastAssistantAnswer, normalizePane, paneLooksBusy, paneShowsInputPrompt } from "./heuristics.ts";

export type SendState = {
  sentAt: number;
  prompt: string;
  submitMethod?: string;
};

export type InteractiveSnapshot = {
  pane: string;
  scopedPane: string;
  busy: boolean;
  promptVisible: boolean;
  answer: string;
  answerVisible: boolean;
  streamDelta: string;
  streamTailText?: string;
  logPath?: string;
  streamBytes?: number;
};

export function streamRootDir(): string {
  return path.join(tmpdir(), "openclaw-cursor-bridge-streams");
}

export function streamLogPath(session: string): string {
  return path.join(streamRootDir(), `${session}.log`);
}

export async function ensureStreamRoot(): Promise<void> {
  await mkdir(streamRootDir(), { recursive: true });
}

export async function resetStreamCapture(session: string, streamReadOffsets: Map<string, number>): Promise<string> {
  await ensureStreamRoot();
  const logPath = streamLogPath(session);
  await rm(logPath, { force: true }).catch(() => {});
  await writeFile(logPath, "", "utf8");
  streamReadOffsets.set(session, 0);
  return logPath;
}

export async function readStreamLog(session: string): Promise<string> {
  const logPath = streamLogPath(session);
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return "";
  }
}

export async function readStreamDelta(session: string, streamReadOffsets: Map<string, number>, reset = false): Promise<{ delta: string; offset: number; logPath: string }> {
  const logPath = streamLogPath(session);
  const raw = await readStreamLog(session);
  const prior = reset ? 0 : (streamReadOffsets.get(session) ?? 0);
  const safePrior = Math.max(0, Math.min(prior, raw.length));
  const delta = raw.slice(safePrior);
  streamReadOffsets.set(session, raw.length);
  return { delta: cleanStreamText(delta), offset: raw.length, logPath };
}

export async function markStreamOffset(session: string, streamReadOffsets: Map<string, number>): Promise<number> {
  const raw = await readStreamLog(session);
  streamReadOffsets.set(session, raw.length);
  return raw.length;
}

export async function peekStreamTail(session: string, maxChars = 12000): Promise<{ text: string; logPath: string; bytes: number }> {
  const logPath = streamLogPath(session);
  const raw = await readStreamLog(session);
  const slice = raw.length > maxChars ? raw.slice(raw.length - maxChars) : raw;
  return { text: cleanStreamText(slice), logPath, bytes: raw.length };
}

export function preferStreamOutput(streamText: string, paneText: string, busy: boolean): string {
  const cleanStream = cleanStreamText(streamText);
  const cleanPane = cleanStreamText(paneText);
  if (busy && cleanStream) return cleanStream;
  return cleanPane || cleanStream;
}

export function trimToSessionBaseline(session: string, pane: string, sessionBaselines: Map<string, string>): string {
  const baseline = sessionBaselines.get(session);
  if (!baseline) return pane;
  const idx = pane.lastIndexOf(baseline);
  if (idx === -1) return pane;
  return pane.slice(idx + baseline.length).trimStart();
}

export function trimToLastSendContext(session: string, pane: string, sessionBaselines: Map<string, string>, lastSendState: Map<string, SendState>): string {
  const baselineTrimmed = trimToSessionBaseline(session, pane, sessionBaselines);
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

export async function captureInteractiveSnapshot(
  session: string,
  lines: number,
  includeTail: boolean,
  capturePane: (session: string, lines?: number) => Promise<string>,
  sessionBaselines: Map<string, string>,
  lastSendState: Map<string, SendState>,
  streamReadOffsets: Map<string, number>,
): Promise<InteractiveSnapshot> {
  const pane = await capturePane(session, lines);
  const scopedPane = trimToLastSendContext(session, pane, sessionBaselines, lastSendState);
  const streamDeltaResult = await readStreamDelta(session, streamReadOffsets);
  const tail = includeTail ? await peekStreamTail(session, 16000) : undefined;
  const answer = extractLastAssistantAnswer(scopedPane || pane);
  return {
    pane,
    scopedPane,
    busy: paneLooksBusy(pane),
    promptVisible: paneShowsInputPrompt(pane),
    answer,
    answerVisible: answer.length > 0 && answer !== ">",
    streamDelta: streamDeltaResult.delta || "",
    streamTailText: tail?.text,
    logPath: tail?.logPath,
    streamBytes: tail?.bytes,
  };
}

export function buildInteractiveOutput(snapshot: InteractiveSnapshot) {
  const liveOutput = preferStreamOutput(snapshot.streamDelta || snapshot.streamTailText || "", snapshot.scopedPane || snapshot.pane, snapshot.busy);
  return {
    busy: snapshot.busy,
    output: (snapshot.busy ? liveOutput : (snapshot.answer || liveOutput || snapshot.scopedPane || snapshot.pane)).trim(),
    rawOutput: (snapshot.streamTailText || snapshot.scopedPane || snapshot.pane || "").trim(),
    liveOutput: (snapshot.streamDelta || "").trim(),
    logPath: snapshot.logPath,
    streamBytes: snapshot.streamBytes,
  };
}
