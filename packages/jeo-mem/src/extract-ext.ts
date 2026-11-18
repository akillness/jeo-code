import type { Extracted, RawImport, RawNode } from "./extract.ts";

const EXT_RE = /\.(c|h|cpp|hpp|cc|hh|cxx|hxx|cs|go|java|kt|kts|swift|rb|php|sh|bash|zsh)$/i;

export const isExtScript = (name: string): boolean => EXT_RE.test(name);

const CALL_SKIP: Record<string, true> = {
  if: true, else: true, elif: true, for: true, foreach: true, while: true, until: true,
  unless: true, do: true, switch: true, case: true, when: true, match: true, select: true,
  catch: true, try: true, finally: true, return: true, throw: true, yield: true, await: true,
  sizeof: true, typeof: true, alignof: true, decltype: true, nameof: true, new: true, delete: true,
  static_cast: true, dynamic_cast: true, reinterpret_cast: true, const_cast: true,
  synchronized: true, lock: true, using: true, assert: true, super: true, this: true, self: true,
  print: true, println: true, printf: true, sprintf: true, fprintf: true, snprintf: true, puts: true,
  len: true, cap: true, append: true, make: true, isinstance: true, isset: true, unset: true,
  empty: true, die: true, exit: true,
};

const SHELL_CMD_SKIP: Record<string, true> = {
  if: true, then: true, else: true, elif: true, fi: true, for: true, in: true, do: true,
  done: true, while: true, until: true, case: true, esac: true, select: true, function: true,
  time: true, coproc: true, local: true, declare: true, typeset: true, export: true, readonly: true,
  unset: true, return: true, exit: true, break: true, continue: true, shift: true, trap: true,
  eval: true, exec: true, source: true, echo: true, printf: true, cd: true, pwd: true, pushd: true,
  popd: true, test: true, true: true, false: true, set: true, shopt: true, read: true, wait: true,
  kill: true, alias: true, unalias: true, command: true, builtin: true, type: true, which: true,
  mkdir: true, rmdir: true, rm: true, cp: true, mv: true, ln: true, touch: true, chmod: true,
  chown: true, cat: true, ls: true, grep: true, egrep: true, fgrep: true, sed: true, awk: true,
  find: true, xargs: true, sort: true, uniq: true, head: true, tail: true, wc: true, cut: true,
  tr: true, tee: true, sleep: true, date: true, basename: true, dirname: true, realpath: true,
  mktemp: true, curl: true, wget: true, git: true, npm: true, bun: true, node: true, python: true,
  python3: true, docker: true, kubectl: true, jq: true,
};

interface StripOpts {
  hashComments?: boolean;
  phpHashComments?: boolean;
  shellComments?: boolean;
  nestedBlockComments?: boolean;
  backtickStrings?: boolean;
  singleQuoteStrings?: boolean;
  cppDigitSep?: boolean;
  tripleQuotes?: boolean;
  rubyBeginEnd?: boolean;
}

/**
 * Produces two line-aligned arrays from `text`:
 * - `importLines`: comments stripped, string literals preserved (for #include / import / require).
 * - `codeLines`: comments and string literals replaced with spaces (for brace depth & call scanning).
 */
function stripSource(text: string, opts: StripOpts): { importLines: string[]; codeLines: string[] } {
  const impOut: string[] = [];
  const codeOut: string[] = [];
  const n = text.length;
  let i = 0;
  let blockDepth = 0;
  let inLineComment = false;
  let inRubyBlock = false;
  let stringQuote: "" | '"' | "'" | "`" | '"""' = "";
  let lineStart = true;

  const pushBoth = (ch: string) => {
    impOut.push(ch);
    codeOut.push(ch);
  };
  const pushCodeSpace = (ch: string, keepInImport: boolean) => {
    if (ch === "\n") {
      impOut.push("\n");
      codeOut.push("\n");
    } else {
      impOut.push(keepInImport ? ch : " ");
      codeOut.push(" ");
    }
  };

  while (i < n) {
    const ch = text[i]!;
    const next = i + 1 < n ? text[i + 1]! : "";

    if (ch === "\r") {
      i++;
      continue;
    }

    if (ch === "\n") {
      inLineComment = false;
      lineStart = true;
      pushBoth("\n");
      i++;
      continue;
    }

    if (inLineComment) {
      pushCodeSpace(ch, false);
      i++;
      continue;
    }

    if (opts.rubyBeginEnd && lineStart && !stringQuote && blockDepth === 0) {
      if (!inRubyBlock && text.startsWith("=begin", i) && (i + 6 >= n || /\s/.test(text[i + 6]!))) {
        inRubyBlock = true;
        for (let k = 0; k < 6; k++) pushCodeSpace(text[i + k]!, false);
        i += 6;
        lineStart = false;
        continue;
      }
      if (inRubyBlock && text.startsWith("=end", i) && (i + 4 >= n || /\s/.test(text[i + 4]!))) {
        inRubyBlock = false;
        for (let k = 0; k < 4; k++) pushCodeSpace(text[i + k]!, false);
        i += 4;
        lineStart = false;
        continue;
      }
    }

    if (inRubyBlock) {
      pushCodeSpace(ch, false);
      lineStart = false;
      i++;
      continue;
    }

    if (blockDepth > 0) {
      if (opts.nestedBlockComments && ch === "/" && next === "*") {
        blockDepth++;
        pushCodeSpace("/", false);
        pushCodeSpace("*", false);
        i += 2;
        lineStart = false;
        continue;
      }
      if (ch === "*" && next === "/") {
        blockDepth--;
        pushCodeSpace("*", false);
        pushCodeSpace("/", false);
        i += 2;
        lineStart = false;
        continue;
      }
      pushCodeSpace(ch, false);
      lineStart = false;
      i++;
      continue;
    }

    if (stringQuote) {
      if (stringQuote === '"""') {
        if (text.startsWith('"""', i)) {
          stringQuote = "";
          pushCodeSpace('"', true);
          pushCodeSpace('"', true);
          pushCodeSpace('"', true);
          i += 3;
          lineStart = false;
          continue;
        }
        pushCodeSpace(ch, true);
        i++;
        lineStart = false;
        continue;
      }
      if (ch === "\\" && stringQuote !== "`" && i + 1 < n && text[i + 1] !== "\n") {
        pushCodeSpace(ch, true);
        pushCodeSpace(text[i + 1]!, true);
        i += 2;
        lineStart = false;
        continue;
      }
      if (ch === stringQuote) {
        stringQuote = "";
        pushCodeSpace(ch, true);
        i++;
        lineStart = false;
        continue;
      }
      pushCodeSpace(ch, true);
      i++;
      lineStart = false;
      continue;
    }

    if (!opts.shellComments && !opts.rubyBeginEnd && ch === "/" && next === "/") {
      inLineComment = true;
      pushCodeSpace("/", false);
      pushCodeSpace("/", false);
      i += 2;
      lineStart = false;
      continue;
    }

    if (!opts.shellComments && !opts.rubyBeginEnd && ch === "/" && next === "*") {
      blockDepth = 1;
      pushCodeSpace("/", false);
      pushCodeSpace("*", false);
      i += 2;
      lineStart = false;
      continue;
    }

    if (opts.hashComments && ch === "#") {
      if (opts.phpHashComments && next === "[") {
        // PHP 8 attribute #[...]
      } else if (opts.shellComments) {
        const prev = i > 0 ? text[i - 1]! : "\n";
        if (lineStart || prev === " " || prev === "\t" || prev === ";") {
          inLineComment = true;
          pushCodeSpace("#", false);
          i++;
          lineStart = false;
          continue;
        }
      } else {
        inLineComment = true;
        pushCodeSpace("#", false);
        i++;
        lineStart = false;
        continue;
      }
    }

    if (opts.tripleQuotes && text.startsWith('"""', i)) {
      stringQuote = '"""';
      pushCodeSpace('"', true);
      pushCodeSpace('"', true);
      pushCodeSpace('"', true);
      i += 3;
      lineStart = false;
      continue;
    }

    if (ch === '"') {
      stringQuote = '"';
      pushCodeSpace('"', true);
      i++;
      lineStart = false;
      continue;
    }

    if (opts.singleQuoteStrings && ch === "'") {
      if (opts.cppDigitSep) {
        const prev = i > 0 ? text[i - 1]! : "";
        if (/[0-9a-fA-F]/.test(prev) && /[0-9a-fA-F]/.test(next)) {
          pushBoth(ch);
          i++;
          lineStart = false;
          continue;
        }
      }
      stringQuote = "'";
      pushCodeSpace("'", true);
      i++;
      lineStart = false;
      continue;
    }

    if (opts.backtickStrings && ch === "`") {
      stringQuote = "`";
      pushCodeSpace("`", true);
      i++;
      lineStart = false;
      continue;
    }

    if (ch !== " " && ch !== "\t") lineStart = false;
    pushBoth(ch);
    i++;
  }

  return {
    importLines: impOut.join("").split("\n"),
    codeLines: codeOut.join("").split("\n"),
  };
}

function dedupeRefs(nodes: RawNode[]): void {
  for (const n of nodes) {
    const seen = new Set<string>();
    n.refs = n.refs.filter((r) => {
      const k = `${r.kind}|${r.recv}|${r.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
}

function scanCalls(line: string, owner: RawNode, extraSkip?: Record<string, true>): void {
  const re = /(?:(\b[A-Za-z_]\w*)\s*(?:\.|->)\s*)?(\b[A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const rawRecv = m[1] ?? "";
    const nm = m[2]!;
    if (CALL_SKIP[nm] || extraSkip?.[nm]) continue;
    if (nm === owner.name && !rawRecv) continue;
    const recv = rawRecv === "self" || rawRecv === "this" ? "this" : rawRecv;
    owner.refs.push({ name: nm, kind: "calls", recv });
  }
}

function hasUnclosedDelim(s: string): boolean {
  let paren = 0;
  let angle = 0;
  for (const ch of s) {
    if (ch === "(") paren++;
    else if (ch === ")" && paren > 0) paren--;
    else if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
  }
  return paren > 0 || angle > 0;
}

function peekHeader(codeLines: string[], idx: number): { header: string; hasBrace: boolean } {
  const first = codeLines[idx] ?? "";
  if (first.includes("{")) return { header: first.slice(0, first.indexOf("{") + 1), hasBrace: true };
  if (first.includes(";")) return { header: first, hasBrace: false };
  const trimmed = first.trim();
  if (!trimmed) return { header: first, hasBrace: false };
  const parts = [trimmed];
  const maxLook = Math.min(codeLines.length - 1, idx + 6);
  for (let j = idx + 1; j <= maxLook; j++) {
    const t = (codeLines[j] ?? "").trim();
    if (!t) break;
    const joined = parts.join(" ");
    const open = hasUnclosedDelim(joined) || /(?:[,:(]|->|\b(?:extends|implements|throws|where))\s*$/.test(joined);
    if (!open && !/^(?:\{|:|->|\b(?:extends|implements|throws|where|const|override|final|noexcept)\b)/.test(t)) {
      break;
    }
    const bIdx = t.indexOf("{");
    const sIdx = t.indexOf(";");
    if (bIdx !== -1 && (sIdx === -1 || bIdx < sIdx)) {
      parts.push(t.slice(0, bIdx + 1));
      return { header: parts.join(" "), hasBrace: true };
    }
    if (sIdx !== -1) {
      return { header: `${joined} ${t.slice(0, sIdx + 1)}`, hasBrace: false };
    }
    parts.push(t);
  }
  return { header: parts.join(" "), hasBrace: false };
}

function updateBraces(line: string, depth: number, stack: { depth: number; node: RawNode }[], lineNum: number): number {
  for (const ch of line) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      while (stack.length > 1 && depth <= stack[stack.length - 1]!.depth) {
        stack.pop()!.node.endLine = lineNum;
      }
    }
  }
  return depth;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let angle = 0;
  let paren = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
    else if (ch === "(") paren++;
    else if (ch === ")" && paren > 0) paren--;
    else if (ch === "," && angle === 0 && paren === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function stemOf(spec: string): string {
  const clean = spec.replace(/\\/g, "/").split("/").pop() || spec;
  return clean.replace(/\.[^.]+$/, "") || clean;
}

function addExtendsRefs(node: RawNode, listText: string | undefined): void {
  if (!listText) return;
  for (const part of splitTopLevel(listText)) {
    const cleaned = part
      .replace(/<[^>]*>/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/\bwhere\b.*/g, "")
      .replace(/\b(public|protected|private|virtual)\b/g, "")
      .trim();
    const m = /([A-Za-z_]\w*)\s*$/.exec(cleaned);
    if (m) node.refs.push({ name: m[1]!, kind: "extends", recv: "" });
  }
}

// ---------------------------------------------------------------------------
// 1. C / C++
// ---------------------------------------------------------------------------
const C_CTRL_RE = /^\s*(?:if|else|for|while|switch|catch|return|typedef|using|friend|namespace|class|struct|enum|union|case|default|#)\b/;

function extractCpp(text: string): Extracted {
  const { importLines, codeLines } = stripSource(text, {
    singleQuoteStrings: true,
    cppDigitSep: true,
  });
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, codeLines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: { depth: number; node: RawNode }[] = [{ depth: -1, node: mod }];
  let depth = 0;

  const incRe = /^\s*#\s*include\s*(?:"([^"]+)"|<([^>]+)>)/;
  const usingNsRe = /^\s*using\s+namespace\s+([\w:]+)\s*;/;
  const nsRe = /^\s*(?:inline\s+)?namespace\s+([\w:]+)\s*\{/;
  const typeRe = /^\s*(?:template\s*<[^>]*>\s*)?(?:typedef\s+)?(class|struct|enum(?:\s+(?:class|struct))?|union)\s+(\w+)(?:\s*:\s*([^{;]+))?\s*\{/;
  const fnRe = /^\s*(?:template\s*<[^>]*>\s*)?(?:[\w:~<>*&\s,\[\]]+?\s+)?(?:(\w+(?:::\w+)*)::)?(~?\w+|operator\S+)\s*\(([^;]*)\)\s*(?:const\b|noexcept(?:\([^)]*\))?|override\b|final\b|volatile\b|->\s*[\w:<>*&\s]+|:\s*[^{;]+|\s)*\{/;

  for (let i = 0; i < codeLines.length; i++) {
    const raw = codeLines[i]!;
    const imp = importLines[i]!;
    const trimmed = raw.trim();

    if (imp.trim()) {
      const mInc = incRe.exec(imp);
      if (mInc) {
        const qPath = mInc[1];
        const sysPath = mInc[2];
        if (qPath) {
          const spec = qPath.startsWith(".") ? qPath : `./${qPath}`;
          imports.push({ spec, imported: "*", local: stemOf(qPath), reexport: false });
        } else if (sysPath) {
          imports.push({ spec: sysPath, imported: "*", local: stemOf(sysPath), reexport: false });
        }
        depth = updateBraces(raw, depth, stack, i + 1);
        continue;
      }
      const mUse = usingNsRe.exec(imp);
      if (mUse) {
        const ns = mUse[1]!;
        const leaf = ns.split("::").pop() || ns;
        imports.push({ spec: ns, imported: "*", local: leaf, reexport: false });
        depth = updateBraces(raw, depth, stack, i + 1);
        continue;
      }
    }

    if (trimmed && !trimmed.startsWith("}") && !/^(?:public|protected|private|signals|slots)\s*:$/.test(trimmed)) {
      const owner = stack[stack.length - 1]!.node;
      const inContainer = owner.kind === "module" || owner.kind === "namespace" || owner.kind === "class" || owner.kind === "struct";

      if (inContainer) {
        const { header, hasBrace } = peekHeader(codeLines, i);
        if (hasBrace) {
          const mNs = nsRe.exec(header);
          if (mNs) {
            const leaf = mNs[1]!.split("::").pop() || mNs[1]!;
            const node: RawNode = { name: leaf, kind: "namespace", startLine: i + 1, endLine: i + 1, exported: true, refs: [] };
            nodes.push(node);
            stack.push({ depth, node });
            depth = updateBraces(raw, depth, stack, i + 1);
            continue;
          }
          const mType = typeRe.exec(header);
          if (mType) {
            const rawKind = mType[1]!.split(/\s+/)[0]!;
            const kind = rawKind === "union" ? "struct" : rawKind;
            const node: RawNode = { name: mType[2]!, kind, startLine: i + 1, endLine: i + 1, exported: true, refs: [] };
            addExtendsRefs(node, mType[3]);
            nodes.push(node);
            stack.push({ depth, node });
            depth = updateBraces(raw, depth, stack, i + 1);
            continue;
          }
          if (!C_CTRL_RE.test(header)) {
            const beforeParen = header.slice(0, header.indexOf("("));
            if (!beforeParen.includes("=") || /\boperator\s*=/.test(beforeParen)) {
              const mFn = fnRe.exec(header);
              if (mFn) {
                const nm = mFn[2]!;
                if (!CALL_SKIP[nm]) {
                  const isStatic = /\bstatic\b/.test(beforeParen) && owner.kind === "module";
                  const isMethod = Boolean(mFn[1]) || owner.kind === "class" || owner.kind === "struct";
                  const node: RawNode = {
                    name: nm,
                    kind: isMethod ? "method" : "function",
                    startLine: i + 1,
                    endLine: i + 1,
                    exported: !isStatic,
                    refs: [],
                  };
                  nodes.push(node);
                  stack.push({ depth, node });
                }
              }
            }
          }
        }
      }
    }

    scanCalls(raw, stack[stack.length - 1]!.node);
    depth = updateBraces(raw, depth, stack, i + 1);
  }

  while (stack.length > 1) stack.pop()!.node.endLine = Math.max(1, codeLines.length);
  dedupeRefs(nodes);
  return { nodes, imports };
}

// ---------------------------------------------------------------------------
// 2. Go
// ---------------------------------------------------------------------------
function extractGo(text: string): Extracted {
  const { importLines, codeLines } = stripSource(text, {
    singleQuoteStrings: true,
    backtickStrings: true,
  });
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, codeLines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: { depth: number; node: RawNode }[] = [{ depth: -1, node: mod }];
  let depth = 0;
  let inImportBlock = false;

  const impStartRe = /^\s*import\s*\(\s*$/;
  const impLineRe = /^\s*(?:import\s+)?(?:([A-Za-z_]\w*|\.|_)\s+)?"([^"]+)"/;
  const typeBlockRe = /^\s*type\s+(\w+)(?:\[[^\]]*\])?\s+(struct|interface)\s*\{/;
  const typeAliasRe = /^\s*type\s+(\w+)(?:\[[^\]]*\])?\s+(?!struct\b|interface\b)(\S+)/;
  const funcRe = /^\s*func\s+(\([^)]+\)\s*)?(\w+)(?:\[[^\]]*\])?\s*\(/;

  for (let i = 0; i < codeLines.length; i++) {
    const raw = codeLines[i]!;
    const imp = importLines[i]!;
    const trimmed = raw.trim();

    if (inImportBlock) {
      if (imp.includes(")")) {
        inImportBlock = false;
      } else {
        const m = impLineRe.exec(imp);
        if (m) {
          const spec = m[2]!;
          const alias = m[1];
          const local = alias && alias !== "." && alias !== "_" ? alias : spec.split("/").pop() || spec;
          imports.push({ spec, imported: "*", local, reexport: false });
        }
      }
      depth = updateBraces(raw, depth, stack, i + 1);
      continue;
    }

    if (impStartRe.test(imp)) {
      inImportBlock = true;
      depth = updateBraces(raw, depth, stack, i + 1);
      continue;
    }

    if (/^\s*import\s+/.test(imp)) {
      const m = impLineRe.exec(imp);
      if (m) {
        const spec = m[2]!;
        const alias = m[1];
        const local = alias && alias !== "." && alias !== "_" ? alias : spec.split("/").pop() || spec;
        imports.push({ spec, imported: "*", local, reexport: false });
        depth = updateBraces(raw, depth, stack, i + 1);
        continue;
      }
    }

    if (trimmed && !trimmed.startsWith("}")) {
      const owner = stack[stack.length - 1]!.node;
      if (owner.kind === "module") {
        const { header, hasBrace } = peekHeader(codeLines, i);
        const mType = hasBrace ? typeBlockRe.exec(header) : null;
        if (mType) {
          const nm = mType[1]!;
          const node: RawNode = { name: nm, kind: mType[2]!, startLine: i + 1, endLine: i + 1, exported: /^[A-Z]/.test(nm), refs: [] };
          nodes.push(node);
          stack.push({ depth, node });
          depth = updateBraces(raw, depth, stack, i + 1);
          continue;
        }
        const mAlias = typeAliasRe.exec(trimmed);
        if (mAlias) {
          const nm = mAlias[1]!;
          nodes.push({ name: nm, kind: "type", startLine: i + 1, endLine: i + 1, exported: /^[A-Z]/.test(nm), refs: [] });
          depth = updateBraces(raw, depth, stack, i + 1);
          continue;
        }
        if (hasBrace) {
          const mFn = funcRe.exec(header);
          if (mFn) {
            const nm = mFn[2]!;
            const node: RawNode = {
              name: nm,
              kind: mFn[1] ? "method" : "function",
              startLine: i + 1,
              endLine: i + 1,
              exported: /^[A-Z]/.test(nm),
              refs: [],
            };
            nodes.push(node);
            stack.push({ depth, node });
          }
        }
      }
    }

    scanCalls(raw, stack[stack.length - 1]!.node);
    depth = updateBraces(raw, depth, stack, i + 1);
  }

  while (stack.length > 1) stack.pop()!.node.endLine = Math.max(1, codeLines.length);
  dedupeRefs(nodes);
  return { nodes, imports };
}

// ---------------------------------------------------------------------------
// 3. C#
// ---------------------------------------------------------------------------
const CS_CTRL_RE = /^\s*(?:if|else|for|foreach|while|switch|catch|using|lock|fixed|checked|unchecked|return|throw|new|case|default)\b/;

function extractCSharp(text: string): Extracted {
  const { importLines, codeLines } = stripSource(text, {
    singleQuoteStrings: true,
    tripleQuotes: true,
  });
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, codeLines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: { depth: number; node: RawNode }[] = [{ depth: -1, node: mod }];
  let depth = 0;

  const usingRe = /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/;
  const nsBlockRe = /^\s*namespace\s+([\w.]+)\s*\{/;
  const typeRe = /^\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|abstract|sealed|static|partial|readonly|ref|unsafe|new)\s+)*(class|struct|interface|enum|record(?:\s+(?:struct|class))?)\s+(\w+)(?:<[^>]+>)?(?:\s*\([^)]*\))?(?:\s*:\s*([^{;]+))?\s*\{/;
  const methodRe = /^\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly)\s+)+(?:[\w.<>\[\]?,\s]+?\s+)?(\w+)(?:<[^>]+>)?\s*\([^;]*\)\s*(?:where\s+[^{;]+)?(?:\{|=>)/;

  for (let i = 0; i < codeLines.length; i++) {
    const raw = codeLines[i]!;
    const imp = importLines[i]!;
    const trimmed = raw.trim();

    const mUsing = usingRe.exec(imp);
    if (mUsing) {
      const spec = mUsing[2]!;
      const local = mUsing[1] || spec.split(".").pop() || spec;
      imports.push({ spec, imported: "*", local, reexport: false });
      depth = updateBraces(raw, depth, stack, i + 1);
      continue;
    }

    if (trimmed && !trimmed.startsWith("}")) {
      const owner = stack[stack.length - 1]!.node;
      const inContainer = owner.kind === "module" || owner.kind === "namespace" || owner.kind === "class" || owner.kind === "struct" || owner.kind === "interface";

      if (inContainer) {
        const { header, hasBrace } = peekHeader(codeLines, i);
        if (hasBrace) {
          const mNs = nsBlockRe.exec(header);
          if (mNs) {
            const leaf = mNs[1]!.split(".").pop() || mNs[1]!;
            const node: RawNode = { name: leaf, kind: "namespace", startLine: i + 1, endLine: i + 1, exported: true, refs: [] };
            nodes.push(node);
            stack.push({ depth, node });
            depth = updateBraces(raw, depth, stack, i + 1);
            continue;
          }
          const mType = typeRe.exec(header);
          if (mType) {
            const rawKind = mType[1]!.split(/\s+/)[0]!;
            const kind = rawKind === "record" ? "class" : rawKind;
            const node: RawNode = {
              name: mType[2]!,
              kind,
              startLine: i + 1,
              endLine: i + 1,
              exported: /\b(public|internal)\b/.test(header),
              refs: [],
            };
            addExtendsRefs(node, mType[3]);
            nodes.push(node);
            stack.push({ depth, node });
            depth = updateBraces(raw, depth, stack, i + 1);
            continue;
          }
        }
        if ((owner.kind === "class" || owner.kind === "struct" || owner.kind === "interface") && !CS_CTRL_RE.test(header)) {
          const candidate = hasBrace ? header : trimmed;
          const mMethod = methodRe.exec(candidate);
          if (mMethod && !CALL_SKIP[mMethod[1]!]) {
            const node: RawNode = {
              name: mMethod[1]!,
              kind: "method",
              startLine: i + 1,
              endLine: i + 1,
              exported: /\b(public|internal|protected)\b/.test(candidate),
              refs: [],
            };
            nodes.push(node);
            if (hasBrace) {
              stack.push({ depth, node });
            } else {
              scanCalls(raw, node);
              depth = updateBraces(raw, depth, stack, i + 1);
              continue;
            }
          }
        }
      }
    }

    scanCalls(raw, stack[stack.length - 1]!.node);
    depth = updateBraces(raw, depth, stack, i + 1);
  }

  while (stack.length > 1) stack.pop()!.node.endLine = Math.max(1, codeLines.length);
  dedupeRefs(nodes);
  return { nodes, imports };
}

// ---------------------------------------------------------------------------
// 4. Java
// ---------------------------------------------------------------------------
const JAVA_CTRL_RE = /^\s*(?:if|else|for|while|switch|catch|synchronized|try|finally|return|throw|new|case|default|assert)\b/;

function extractJava(text: string): Extracted {
  const { importLines, codeLines } = stripSource(text, {
    singleQuoteStrings: true,
    tripleQuotes: true,
  });
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, codeLines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: { depth: number; node: RawNode }[] = [{ depth: -1, node: mod }];
  let depth = 0;

  const impRe = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/;
  const typeRe = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+(\w+)(?:<[^>]+>)?(?:\s*\([^)]*\))?(?:\s+extends\s+([^{\n]+?))?(?:\s+implements\s+([^{\n]+?))?\s*\{/;
  const methodRe = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?(?:[\w.<>\[\]?,\s]+?\s+)?(\w+)\s*\([^;]*\)\s*(?:throws\s+[^{;]+)?\{/;

  for (let i = 0; i < codeLines.length; i++) {
    const raw = codeLines[i]!;
    const imp = importLines[i]!;
    const trimmed = raw.trim();

    const mImp = impRe.exec(imp);
    if (mImp) {
      const spec = mImp[1]!;
      const isWild = spec.endsWith(".*");
      const parts = spec.split(".");
      const leaf = parts[parts.length - (isWild ? 2 : 1)] || spec;
      imports.push({ spec, imported: isWild ? "*" : leaf, local: leaf, reexport: false });
      depth = updateBraces(raw, depth, stack, i + 1);
      continue;
    }

    if (trimmed && !trimmed.startsWith("}")) {
      const owner = stack[stack.length - 1]!.node;
      const inContainer = owner.kind === "module" || owner.kind === "class" || owner.kind === "interface" || owner.kind === "enum";
      if (inContainer) {
        const { header, hasBrace } = peekHeader(codeLines, i);
        if (hasBrace) {
          const mType = typeRe.exec(header);
          if (mType) {
            const rawK = mType[1]!;
            const kind = rawK === "@interface" ? "interface" : rawK === "record" ? "class" : rawK;
            const node: RawNode = {
              name: mType[2]!,
              kind,
              startLine: i + 1,
              endLine: i + 1,
              exported: /\bpublic\b/.test(header),
              refs: [],
            };
            addExtendsRefs(node, mType[3]);
            addExtendsRefs(node, mType[4]);
            nodes.push(node);
            stack.push({ depth, node });
            depth = updateBraces(raw, depth, stack, i + 1);
            continue;
          }
          if (owner.kind !== "module" && !JAVA_CTRL_RE.test(header)) {
            const beforeParen = header.slice(0, header.indexOf("("));
            if (!beforeParen.includes("=")) {
              const mMethod = methodRe.exec(header);
              if (mMethod && !CALL_SKIP[mMethod[1]!]) {
                const node: RawNode = {
                  name: mMethod[1]!,
                  kind: "method",
                  startLine: i + 1,
                  endLine: i + 1,
                  exported: /\bpublic\b/.test(beforeParen),
                  refs: [],
                };
                nodes.push(node);
                stack.push({ depth, node });
              }
            }
          }
        }
      }
    }

    scanCalls(raw, stack[stack.length - 1]!.node);
    depth = updateBraces(raw, depth, stack, i + 1);
  }

  while (stack.length > 1) stack.pop()!.node.endLine = Math.max(1, codeLines.length);
  dedupeRefs(nodes);
  return { nodes, imports };
}

// ---------------------------------------------------------------------------
// 5. Kotlin
// ---------------------------------------------------------------------------
function extractKotlin(text: string): Extracted {
  const { importLines, codeLines } = stripSource(text, {
    singleQuoteStrings: true,
    tripleQuotes: true,
    nestedBlockComments: true,
  });
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, codeLines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: { depth: number; node: RawNode }[] = [{ depth: -1, node: mod }];
  let depth = 0;

  const impRe = /^\s*import\s+([\w.*]+)(?:\s+as\s+(\w+))?/;
  const typeRe = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|open|abstract|final|sealed|data|value|inline|inner|annotation|enum|expect|actual)\s+)*(class|interface|object)\s+(\w+)(?:<[^>]+>)?(?:\s*\([^)]*\))?(?:\s*:\s*([^{=]+))?/;
  const funRe = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|open|override|abstract|final|suspend|inline|infix|operator|tailrec|external|actual|expect)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.<>?]+\.)?(\w+)\s*\(/;

  for (let i = 0; i < codeLines.length; i++) {
    const raw = codeLines[i]!;
    const imp = importLines[i]!;
    const trimmed = raw.trim();

    const mImp = impRe.exec(imp);
    if (mImp) {
      const spec = mImp[1]!;
      const isWild = spec.endsWith(".*");
      const parts = spec.split(".");
      const leaf = parts[parts.length - (isWild ? 2 : 1)] || spec;
      const local = mImp[2] || leaf;
      imports.push({ spec, imported: isWild ? "*" : leaf, local, reexport: false });
      depth = updateBraces(raw, depth, stack, i + 1);
      continue;
    }

    if (trimmed && !trimmed.startsWith("}")) {
      const owner = stack[stack.length - 1]!.node;
      const inContainer = owner.kind === "module" || owner.kind === "class" || owner.kind === "interface" || owner.kind === "enum";
      if (inContainer) {
        const { header, hasBrace } = peekHeader(codeLines, i);
        const mType = typeRe.exec(trimmed) || (hasBrace ? typeRe.exec(header) : null);
        if (mType) {
          const isEnum = /\benum\s+class\b/.test(mType[0]);
          const kind = isEnum ? "enum" : mType[1] === "object" ? "class" : mType[1]!;
          const node: RawNode = {
            name: mType[2]!,
            kind,
            startLine: i + 1,
            endLine: i + 1,
            exported: !/\bprivate\b/.test(mType[0]),
            refs: [],
          };
          addExtendsRefs(node, mType[3]);
          nodes.push(node);
          if (hasBrace) {
            stack.push({ depth, node });
            depth = updateBraces(raw, depth, stack, i + 1);
            continue;
          }
          scanCalls(raw, node);
          depth = updateBraces(raw, depth, stack, i + 1);
          continue;
        }
        const mFun = funRe.exec(header);
        if (mFun) {
          const node: RawNode = {
            name: mFun[1]!,
            kind: owner.kind === "module" ? "function" : "method",
            startLine: i + 1,
            endLine: i + 1,
            exported: !/\bprivate\b/.test(mFun[0]),
            refs: [],
          };
          nodes.push(node);
          if (hasBrace) {
            stack.push({ depth, node });
          } else {
            scanCalls(raw, node);
            depth = updateBraces(raw, depth, stack, i + 1);
            continue;
          }
        }
      }
    }

    scanCalls(raw, stack[stack.length - 1]!.node);
    depth = updateBraces(raw, depth, stack, i + 1);
  }

  while (stack.length > 1) stack.pop()!.node.endLine = Math.max(1, codeLines.length);
  dedupeRefs(nodes);
  return { nodes, imports };
}

// ---------------------------------------------------------------------------
// 6. Swift
// ---------------------------------------------------------------------------
function extractSwift(text: string): Extracted {
  const { importLines, codeLines } = stripSource(text, {
    tripleQuotes: true,
    nestedBlockComments: true,
  });
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, codeLines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: { depth: number; node: RawNode }[] = [{ depth: -1, node: mod }];
  let depth = 0;

  const impRe = /^\s*(?:@testable\s+)?import\s+(?:(?:class|struct|enum|protocol|func|var|typealias)\s+)?([\w.]+)/;
  const typeRe = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|open|internal|private|fileprivate|final|indirect)\s+)*(class|struct|protocol|enum|actor|extension)\s+([\w.]+)(?:<[^>]+>)?(?:\s*:\s*([^{]+))?\s*\{/;
  const fnRe = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|open|internal|private|fileprivate|static|class|override|mutating|nonmutating|final|convenience|required)\s+)*(?:func\s+(\w+)|(init)\b)/;

  for (let i = 0; i < codeLines.length; i++) {
    const raw = codeLines[i]!;
    const imp = importLines[i]!;
    const trimmed = raw.trim();

    const mImp = impRe.exec(imp);
    if (mImp) {
      const spec = mImp[1]!;
      const leaf = spec.split(".").pop() || spec;
      imports.push({ spec, imported: "*", local: leaf, reexport: false });
      depth = updateBraces(raw, depth, stack, i + 1);
      continue;
    }

    if (trimmed && !trimmed.startsWith("}")) {
      const owner = stack[stack.length - 1]!.node;
      const inContainer = owner.kind === "module" || owner.kind === "class" || owner.kind === "struct" || owner.kind === "interface" || owner.kind === "enum";
      if (inContainer) {
        const { header, hasBrace } = peekHeader(codeLines, i);
        if (hasBrace) {
          const mType = typeRe.exec(header);
          if (mType) {
            const rawK = mType[1]!;
            const kind = rawK === "protocol" ? "interface" : rawK === "actor" || rawK === "extension" ? "class" : rawK;
            const leaf = mType[2]!.split(".").pop() || mType[2]!;
            const node: RawNode = {
              name: leaf,
              kind,
              startLine: i + 1,
              endLine: i + 1,
              exported: !/\b(private|fileprivate)\b/.test(header),
              refs: [],
            };
            addExtendsRefs(node, mType[3]);
            nodes.push(node);
            stack.push({ depth, node });
            depth = updateBraces(raw, depth, stack, i + 1);
            continue;
          }
          const mFn = fnRe.exec(header);
          if (mFn) {
            const nm = mFn[1] || mFn[2]!;
            const node: RawNode = {
              name: nm,
              kind: owner.kind === "module" ? "function" : "method",
              startLine: i + 1,
              endLine: i + 1,
              exported: !/\b(private|fileprivate)\b/.test(header),
              refs: [],
            };
            nodes.push(node);
            stack.push({ depth, node });
          }
        }
      }
    }

    scanCalls(raw, stack[stack.length - 1]!.node);
    depth = updateBraces(raw, depth, stack, i + 1);
  }

  while (stack.length > 1) stack.pop()!.node.endLine = Math.max(1, codeLines.length);
  dedupeRefs(nodes);
  return { nodes, imports };
}

// ---------------------------------------------------------------------------
// 7. Ruby
// ---------------------------------------------------------------------------
function extractRuby(text: string): Extracted {
  const { importLines, codeLines } = stripSource(text, {
    hashComments: true,
    singleQuoteStrings: true,
    backtickStrings: true,
    rubyBeginEnd: true,
  });
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, codeLines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const rubyStack: { node: RawNode | null }[] = [{ node: mod }];

  const reqRelRe = /^\s*require_relative\s*\(?\s*['"]([^'"]+)['"]\s*\)?/;
  const reqRe = /^\s*require\s*\(?\s*['"]([^'"]+)['"]\s*\)?/;
  const modRe = /^\s*module\s+([\w:]+)/;
  const clsRe = /^\s*class\s+([\w:]+)(?:\s*<\s*([\w:]+))?/;
  const defRe = /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/;

  const currentOwner = (): RawNode => {
    for (let k = rubyStack.length - 1; k >= 0; k--) {
      if (rubyStack[k]!.node) return rubyStack[k]!.node!;
    }
    return mod;
  };

  for (let i = 0; i < codeLines.length; i++) {
    const raw = codeLines[i]!;
    const imp = importLines[i]!;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const mRel = reqRelRe.exec(imp);
    if (mRel) {
      let spec = mRel[1]!;
      if (!spec.startsWith(".")) spec = `./${spec}`;
      if (!spec.endsWith(".rb")) spec = `${spec}.rb`;
      imports.push({ spec, imported: "*", local: stemOf(spec), reexport: false });
      continue;
    }
    const mReq = reqRe.exec(imp);
    if (mReq) {
      const spec = mReq[1]!;
      imports.push({ spec, imported: "*", local: stemOf(spec), reexport: false });
      continue;
    }

    let pushedNode: RawNode | null = null;
    const owner = currentOwner();

    const mMod = modRe.exec(raw);
    if (mMod) {
      const leaf = mMod[1]!.split("::").pop() || mMod[1]!;
      pushedNode = { name: leaf, kind: "namespace", startLine: i + 1, endLine: i + 1, exported: true, refs: [] };
      nodes.push(pushedNode);
    } else {
      const mCls = clsRe.exec(raw);
      if (mCls) {
        const leaf = mCls[1]!.split("::").pop() || mCls[1]!;
        pushedNode = { name: leaf, kind: "class", startLine: i + 1, endLine: i + 1, exported: true, refs: [] };
        if (mCls[2]) {
          const parentLeaf = mCls[2].split("::").pop() || mCls[2];
          pushedNode.refs.push({ name: parentLeaf, kind: "extends", recv: "" });
        }
        nodes.push(pushedNode);
      } else {
        const mDef = defRe.exec(raw);
        if (mDef) {
          const kind = owner.kind === "class" || owner.kind === "namespace" ? "method" : "function";
          pushedNode = { name: mDef[1]!, kind, startLine: i + 1, endLine: i + 1, exported: !mDef[1]!.startsWith("_"), refs: [] };
          nodes.push(pushedNode);
          if (/\)\s*=\s*\S/.test(trimmed) || /^def\s+\S+\s*=\s*\S/.test(trimmed)) {
            scanCalls(raw, pushedNode);
            continue;
          }
        }
      }
    }

    if (pushedNode) {
      rubyStack.push({ node: pushedNode });
      if (/;\s*end\b/.test(trimmed) || /\bend\s*$/.test(trimmed)) {
        const popped = rubyStack.pop();
        if (popped?.node) popped.node.endLine = i + 1;
      }
      scanCalls(raw, pushedNode);
      continue;
    }

    const opensBlock =
      /^\s*(?:if|unless|case|while|until|for|begin)\b/.test(raw) ||
      (/\b(?:if|unless|case|begin)\b/.test(trimmed) && /^\s*(?:\w+\s*=)?\s*(?:if|unless|case|begin)\b/.test(raw)) ||
      /\bdo(?:\s*\|[^|]*\|)?\s*(?:#.*)?$/.test(trimmed);

    if (opensBlock) rubyStack.push({ node: null });

    scanCalls(raw, currentOwner());

    if (/^\s*end\b/.test(trimmed) || /;\s*end\b/.test(trimmed)) {
      if (rubyStack.length > 1) {
        const popped = rubyStack.pop()!;
        if (popped.node) popped.node.endLine = i + 1;
      }
    }
  }

  while (rubyStack.length > 1) {
    const popped = rubyStack.pop()!;
    if (popped.node) popped.node.endLine = Math.max(1, codeLines.length);
  }
  dedupeRefs(nodes);
  return { nodes, imports };
}

// ---------------------------------------------------------------------------
// 8. PHP
// ---------------------------------------------------------------------------
const PHP_CTRL_RE = /^\s*(?:if|elseif|else|for|foreach|while|switch|catch|try|finally|return|throw|new|case|default)\b/;

function extractPhp(text: string): Extracted {
  const { importLines, codeLines } = stripSource(text, {
    hashComments: true,
    phpHashComments: true,
    singleQuoteStrings: true,
    backtickStrings: true,
  });
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, codeLines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: { depth: number; node: RawNode }[] = [{ depth: -1, node: mod }];
  let depth = 0;

  const useRe = /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s+as\s+(\w+))?\s*;/;
  const reqRe = /^\s*(?:require|require_once|include|include_once)\s*(?:\(\s*)?['"]([^'"]+)['"]/;
  const nsBlockRe = /^\s*namespace\s+([\w\\]+)\s*\{/;
  const typeRe = /^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)(?:\s+extends\s+([\w\\,\s]+?))?(?:\s+implements\s+([\w\\,\s]+?))?\s*\{/;
  const fnRe = /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+&?(\w+)\s*\(/;

  for (let i = 0; i < codeLines.length; i++) {
    const raw = codeLines[i]!;
    const imp = importLines[i]!;
    const trimmed = raw.trim();

    const mUse = useRe.exec(imp);
    if (mUse) {
      const spec = mUse[1]!;
      const leaf = spec.split("\\").pop() || spec;
      imports.push({ spec, imported: leaf, local: mUse[2] || leaf, reexport: false });
      depth = updateBraces(raw, depth, stack, i + 1);
      continue;
    }
    const mReq = reqRe.exec(imp);
    if (mReq) {
      const rawPath = mReq[1]!;
      const spec = rawPath.startsWith(".") ? rawPath : `./${rawPath}`;
      imports.push({ spec, imported: "*", local: stemOf(rawPath), reexport: false });
      depth = updateBraces(raw, depth, stack, i + 1);
      continue;
    }

    if (trimmed && !trimmed.startsWith("}")) {
      const owner = stack[stack.length - 1]!.node;
      const inContainer = owner.kind === "module" || owner.kind === "namespace" || owner.kind === "class" || owner.kind === "interface" || owner.kind === "trait" || owner.kind === "enum";
      if (inContainer) {
        const { header, hasBrace } = peekHeader(codeLines, i);
        if (hasBrace) {
          const mNs = nsBlockRe.exec(header);
          if (mNs) {
            const leaf = mNs[1]!.split("\\").pop() || mNs[1]!;
            const node: RawNode = { name: leaf, kind: "namespace", startLine: i + 1, endLine: i + 1, exported: true, refs: [] };
            nodes.push(node);
            stack.push({ depth, node });
            depth = updateBraces(raw, depth, stack, i + 1);
            continue;
          }
          const mType = typeRe.exec(header);
          if (mType) {
            const node: RawNode = { name: mType[2]!, kind: mType[1]!, startLine: i + 1, endLine: i + 1, exported: true, refs: [] };
            addExtendsRefs(node, mType[3]?.replace(/\\/g, "::"));
            addExtendsRefs(node, mType[4]?.replace(/\\/g, "::"));
            nodes.push(node);
            stack.push({ depth, node });
            depth = updateBraces(raw, depth, stack, i + 1);
            continue;
          }
          if (!PHP_CTRL_RE.test(header)) {
            const mFn = fnRe.exec(header);
            if (mFn) {
              const isMethod = owner.kind === "class" || owner.kind === "interface" || owner.kind === "trait" || owner.kind === "enum";
              const node: RawNode = {
                name: mFn[1]!,
                kind: isMethod ? "method" : "function",
                startLine: i + 1,
                endLine: i + 1,
                exported: !/\bprivate\b/.test(header),
                refs: [],
              };
              nodes.push(node);
              stack.push({ depth, node });
            }
          }
        }
      }
    }

    scanCalls(raw, stack[stack.length - 1]!.node);
    depth = updateBraces(raw, depth, stack, i + 1);
  }

  while (stack.length > 1) stack.pop()!.node.endLine = Math.max(1, codeLines.length);
  dedupeRefs(nodes);
  return { nodes, imports };
}

// ---------------------------------------------------------------------------
// 9. Shell (.sh, .bash, .zsh)
// ---------------------------------------------------------------------------
function extractShell(text: string): Extracted {
  const { importLines, codeLines } = stripSource(text, {
    hashComments: true,
    shellComments: true,
    singleQuoteStrings: true,
    backtickStrings: true,
  });
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, codeLines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: { depth: number; node: RawNode }[] = [{ depth: -1, node: mod }];
  let depth = 0;

  const srcRe = /^\s*(?:source|\.)\s+["']?([^\s"';#]+)["']?/;
  const fnKeywordRe = /^\s*function\s+([A-Za-z_][\w-]*)\s*(?:\(\s*\))?\s*\{/;
  const fnPosixRe = /^\s*([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/;
  const cmdStartRe = /(?:^|[;&|]\s*|&&\s*|\|\|\s*|\$\(\s*)(?:[A-Za-z_]\w*=\S*\s+)*([A-Za-z_][\w-]*)(?=\s|$|;|&|\||\))/g;

  for (let i = 0; i < codeLines.length; i++) {
    const raw = codeLines[i]!;
    const imp = importLines[i]!;
    const trimmed = raw.trim();

    const mSrc = srcRe.exec(imp);
    if (mSrc) {
      const rawPath = mSrc[1]!;
      const spec = rawPath.startsWith(".") || rawPath.startsWith("/") || rawPath.startsWith("$") ? rawPath : `./${rawPath}`;
      imports.push({ spec, imported: "*", local: stemOf(rawPath), reexport: false });
      depth = updateBraces(raw, depth, stack, i + 1);
      continue;
    }

    let declared = false;
    if (trimmed && !trimmed.startsWith("}")) {
      const { header, hasBrace } = peekHeader(codeLines, i);
      if (hasBrace) {
        const mFn = fnKeywordRe.exec(header) || fnPosixRe.exec(header);
        if (mFn && !SHELL_CMD_SKIP[mFn[1]!]) {
          const node: RawNode = { name: mFn[1]!, kind: "function", startLine: i + 1, endLine: i + 1, exported: true, refs: [] };
          nodes.push(node);
          stack.push({ depth, node });
          declared = true;
        }
      }
    }

    const owner = stack[stack.length - 1]!.node;
    if (!declared) {
      cmdStartRe.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = cmdStartRe.exec(raw)) !== null) {
        const cmd = cm[1]!;
        if (!SHELL_CMD_SKIP[cmd] && !CALL_SKIP[cmd] && cmd !== owner.name) {
          owner.refs.push({ name: cmd, kind: "calls", recv: "" });
        }
      }
    }

    depth = updateBraces(raw, depth, stack, i + 1);
  }

  while (stack.length > 1) stack.pop()!.node.endLine = Math.max(1, codeLines.length);
  dedupeRefs(nodes);
  return { nodes, imports };
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------
export function extLang(path: string): string {
  const lower = path.toLowerCase();
  if (/\.(c|h)$/.test(lower)) return "c";
  if (/\.(cpp|hpp|cc|hh|cxx|hxx)$/.test(lower)) return "cpp";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".java")) return "java";
  if (/\.(kt|kts)$/.test(lower)) return "kotlin";
  if (lower.endsWith(".swift")) return "swift";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".php")) return "php";
  if (/\.(sh|bash|zsh)$/.test(lower)) return "shell";
  return "ext";
}

export function extractExtScript(path: string, text: string): Extracted {
  const lang = extLang(path);
  switch (lang) {
    case "c":
    case "cpp":
      return extractCpp(text);
    case "go":
      return extractGo(text);
    case "csharp":
      return extractCSharp(text);
    case "java":
      return extractJava(text);
    case "kotlin":
      return extractKotlin(text);
    case "swift":
      return extractSwift(text);
    case "ruby":
      return extractRuby(text);
    case "php":
      return extractPhp(text);
    case "shell":
      return extractShell(text);
    default: {
      const lines = Math.max(1, text.split("\n").length);
      return { nodes: [{ name: "<module>", kind: "module", startLine: 1, endLine: lines, exported: false, refs: [] }], imports: [] };
    }
  }
}
