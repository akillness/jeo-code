/**
 * GJC Bash Command Fixups — conservative, INTENT-PRESERVING, off-by-default rewrites
 * for common CLI mistakes. Every rule is a no-op unless it matches exactly, and no rule
 * may change what the command observably does (only its form). Gated behind
 * `JOC_BASH_FIXUPS=1` by the caller (bashTool); never altered by default.
 *
 * Rules that would CHANGE behavior (e.g. merging stderr into a pipe with `2>&1`, which
 * adds new data to the matched stream) are intentionally NOT included — that is
 * intent-inferring, not intent-preserving.
 */

/** Tokenize respecting single/double quotes (quotes kept in the token). */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
    } else if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
    } else if (char === " " && !inDoubleQuote && !inSingleQuote) {
      if (current) { tokens.push(current); current = ""; }
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Apply intent-preserving, conservative fixups. Returns the (possibly) rewritten
 *  command and the list of rule names applied (empty when nothing matched). */
export function applyBashFixups(command: string): { command: string; applied: string[] } {
  let currentCommand = command;
  const applied: string[] = [];

  // Rule 1: strip-trailing — `ls -la; ` → `ls -la` (drop one trailing `;` + surrounding ws).
  {
    let newCmd = currentCommand.trim();
    if (newCmd.endsWith(";")) newCmd = newCmd.slice(0, -1).trim();
    if (newCmd !== command) {
      currentCommand = newCmd;
      applied.push("strip-trailing");
    }
  }

  // Rule 2: useless-cat — `cat file | grep PAT` → `grep PAT file`.
  // SINGLE-STAGE ONLY: bail if the grep args carry a downstream pipe/compound operator
  // (`| && || ;`), since appending the file after them would corrupt the pipeline
  // (`cat f | grep x | head` must NOT become `grep x | head f`).
  const uselessCatRegex = /^\s*cat\s+((?:'[^']*'|"[^"]*"|[^\s|]+))\s*\|\s*(grep|egrep|fgrep)\s+(.+)$/;
  const catMatch = currentCommand.match(uselessCatRegex);
  if (catMatch && !/[|&;]/.test(catMatch[3]!)) {
    currentCommand = `${catMatch[2]} ${catMatch[3]} ${catMatch[1]}`;
    applied.push("useless-cat");
  }

  // Rule 3: dev-null-merge — both streams discarded two ways → the canonical form.
  // `cmd >/dev/null 2>/dev/null` / `cmd 2>/dev/null 1>/dev/null` → `cmd >/dev/null 2>&1`
  // (behavior-identical: stdout AND stderr both go to /dev/null either way).
  const devNull = /(?:^|\s)(?:1?>\s*\/dev\/null\s+2>\s*\/dev\/null|2>\s*\/dev\/null\s+1?>\s*\/dev\/null)\s*$/;
  if (devNull.test(currentCommand)) {
    currentCommand = currentCommand.replace(devNull, " >/dev/null 2>&1");
    applied.push("dev-null-merge");
  }

  // Rule 4: collapse-dot-slash — `././bin/run` → `./bin/run`.
  const dotSlashRegex = /^\s*(?:\.\/){2,}(.*)$/;
  const dotSlashMatch = currentCommand.match(dotSlashRegex);
  if (dotSlashMatch) {
    const leadingSpaces = currentCommand.match(/^\s*/)?.[0] || "";
    currentCommand = `${leadingSpaces}./${dotSlashMatch[1]}`;
    applied.push("collapse-dot-slash");
  }

  // Rule 5: grep-r-default-path — recursive grep with no path → append ` .`.
  // Matches both short `-r`/`-R` (in a bundled flag) and `--recursive`.
  const tokens = tokenize(currentCommand);
  if (tokens.length > 1 && tokens[0] === "grep") {
    let hasRecursiveFlag = false;
    const posArgs: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.startsWith("-")) {
        if (token === "--recursive") hasRecursiveFlag = true;
        else if (!token.startsWith("--") && /[rR]/.test(token)) hasRecursiveFlag = true;
      } else {
        posArgs.push(token);
      }
    }
    if (hasRecursiveFlag && posArgs.length === 1) {
      currentCommand = `${currentCommand} .`;
      applied.push("grep-r-default-path");
    }
  }

  return { command: currentCommand, applied };
}
