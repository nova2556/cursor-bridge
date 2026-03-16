export function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\r/g, "");
}

export function normalizePane(text: string): string {
  return stripAnsi(text)
    .replace(/[│┃]/g, "|")
    .replace(/[─━]/g, "-")
    .replace(/[┌┐└┘├┤┬┴┼╭╮╯╰╞╡╤╧╪]/g, "")
    .replace(/\u00a0/g, " ");
}

export function isMostlyUiChromeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^[\-|=+<>()[\]{}·•…]{3,}$/.test(t)) return true;
  if (/^(esc|ctrl\+c|enter|tab|shift\+tab|↑|↓|←|→|return|send message|new chat|attach|model|context|review|claude\b|\/ commands\b)\b/i.test(t)) return true;
  if (/\b(ctrl\+c to stop|press .* to|toggle|submit|slash commands?|add a follow-up|auto-run all commands)\b/i.test(t)) return true;
  if (/^(cwd is not a git repository|workspace trust|trust this workspace)/i.test(t)) return true;
  return false;
}

export function stripCommandEchoNoise(text: string): string {
  return (text || "")
    .replace(/^rog@[^\n$]+\$\s.*$/gm, "")
    .replace(/^'.*powershell\.exe'.*$/gim, "")
    .replace(/^.*powershell\.exe.*$/gim, "")
    .replace(/^.*-EncodedCommand\s+'?[A-Za-z0-9+/=]{20,}'?.*$/gim, "")
    .replace(/^[A-Za-z0-9+/=]{40,}$/gm, "")
    .replace(/^\s*\|?\s*→\s*\[Pasted text.*$/gim, "")
    .replace(/^\s*\|?\s*→\s*Add a follow-up.*$/gim, "")
    .replace(/^\s*\|?\s*→\s*Plan, search, build anything\|?\s*$/gim, "")
    .replace(/^\s*\|?\s*ctrl\+c to stop\s*\|?\s*$/gim, "")
    .replace(/^\s*[⬡⬢].*?(Generating|Running|Reading).*$/gim, "")
    .replace(/^\s*Cursor Agent v[\w.-]+\s*$/gim, "")
    .replace(/^\s*[A-Z]:\\.*·\s.*$/gm, "")
    .replace(/^\s*\(cwd is not a git repository.*$/gim, "")
    .replace(/^\s*▶︎?\s*Auto-run all commands.*$/gim, "")
    .replace(/^\s*Claude\s+\d[^\n]*$/gim, "")
    .replace(/^\s*\/ commands · @ files · ! shell\s*$/gim, "")
    .replace(/^\s*Command 'update-motd'.*$/gim, "")
    .replace(/^\s*\*\s*\/sbin\/update-motd\s*$/gim, "")
    .replace(/^\s*\*\s*\/usr\/sbin\/update-motd\s*$/gim, "")
    .replace(/^\s*The command could not be located because.*$/gim, "")
    .replace(/^\s*This is most likely caused by.*$/gim, "")
    .replace(/^\s*update-motd: command not found\s*$/gim, "")
    .replace(/^\s*This message is shown once a day\..*$/gim, "")
    .replace(/^\s*\/home\/rog\/\.hushlogin file\.\s*$/gim, "")
    .replace(/^\s*[|\\/-]{20,}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanStreamText(raw: string): string {
  return stripCommandEchoNoise(
    normalizePane(raw || "")
      .replace(/\[\?2004[hl]\r?/g, "")
      .replace(/\u0007/g, "")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n"),
  ).trim();
}

export function cleanOneShotOutput(raw: string): string {
  const text = stripCommandEchoNoise(
    normalizePane(raw || "")
      .replace(/^#<\s*CLIXML\s*/i, "")
      .replace(/<Objs[\s\S]*?<\/Objs>/g, "")
      .replace(/^.*?ETIMEDOUT.*$/gim, (m) => m),
  ).trim();
  return text;
}

export function extractLastAssistantAnswer(raw: string): string {
  const text = normalizePane(raw);
  const allLines = text.split(/\r?\n/);
  const lines = allLines.map((line) => line.replace(/\s+$/g, ""));
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^>\s?$/.test(lines[i].trim())) {
      promptIdx = i;
      break;
    }
  }
  const upperBound = promptIdx === -1 ? lines.length : promptIdx;
  let start = 0;
  for (let i = upperBound - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^(you:|user:|human:|> )/i.test(t)) {
      start = i + 1;
      break;
    }
    if (/(working|thinking|generating|indexing|ctrl\+c to stop|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/i.test(t)) {
      start = i + 1;
      break;
    }
  }
  const candidate = lines
    .slice(start, upperBound)
    .filter((line) => !isMostlyUiChromeLine(line))
    .filter((line) => !/^rog@[^$]+\$/.test(line.trim()))
    .filter((line) => !/^command ['"].+not found/i.test(line.trim()))
    .filter((line) => !/^'.*powershell\.exe'.*$/i.test(line.trim()))
    .filter((line) => !/^-EncodedCommand\b/i.test(line.trim()))
    .filter((line) => !/^[A-Za-z0-9+/=]{80,}$/.test(line.trim()))
    .filter((line) => !/^(Cursor Agent v|[A-Z]:\\.*·\s|\(cwd is not a git repository|Claude\s+\d|\/ commands · @ files · ! shell)/i.test(line.trim()))
    .filter((line) => !/^(PowerShell\[\.exe\]|-Help, -\?, \/\?|示例|参数|Example[s]?$)/i.test(line.trim()));

  let bestStart = 0;
  for (let i = candidate.length - 1; i >= 0; i -= 1) {
    const t = candidate[i].trim();
    if (!t) continue;
    if (/^CB_[A-Z0-9_]+$/.test(t)) {
      bestStart = i;
      break;
    }
    if (/^⬢\s/.test(t) || /^Read \d+ files?/i.test(t) || /^Created /i.test(t) || /^Updated /i.test(t)) {
      bestStart = i;
      break;
    }
  }

  const collapsed = candidate.slice(bestStart).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return collapsed;
}

export function paneLooksBusy(text: string): boolean {
  return /(Working|Thinking|Generating|Indexing|ctrl\+c to stop|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/i.test(text);
}

export function paneShowsInputPrompt(text: string): boolean {
  return /^>\s?$/m.test(text) || /\n>\s?$/m.test(text) || /add a follow-up|follow-up|queued messages?/i.test(text);
}
