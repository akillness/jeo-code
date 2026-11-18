import ts from "typescript";

export interface RawRef { name: string; kind: "calls" | "extends"; recv: string }
/** imported: original export name, 'default' or '*'. local: binding name (for reexport: the exported-as name). */
export interface RawImport { spec: string; imported: string; local: string; reexport: boolean }
export interface Extracted { nodes: RawNode[]; imports: RawImport[] }
export interface RawNode {
  name: string; kind: string; startLine: number; endLine: number; exported: boolean; refs: RawRef[];
}

const TS_JS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const PY_EXT = /\.py$/;
const RS_EXT = /\.rs$/;
export const isScript = (p: string) => TS_JS_EXT.test(p) || PY_EXT.test(p) || RS_EXT.test(p);

const CALL_SKIP = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "typeof", "match",
  "print", "len", "str", "int", "float", "list", "dict", "set", "tuple", "bool",
  "super", "range", "enumerate", "zip", "isinstance", "hasattr", "getattr",
]);

function extractPython(text: string): Extracted {
  const lines = text.split("\n");
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, lines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: { indent: number; node: RawNode }[] = [{ indent: -1, node: mod }];
  const defRe = /^([ \t]*)(?:async\s+)?(def|class)\s+(\w+)/;
  const impFromRe = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/;
  const impBareRe = /^\s*import\s+(.+)$/;
  const callRe = /\b(\w+)\s*\(/g;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    const dm = defRe.exec(raw);
    if (dm) {
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
        stack.pop()!.node.endLine = i;
      }
      const kind = dm[2] === "class" ? "class" : "function";
      const name = dm[3]!;
      const node: RawNode = { name, kind, startLine: i + 1, endLine: i + 1, exported: !name.startsWith("_"), refs: [] };
      nodes.push(node);
      stack.push({ indent, node });
      continue;
    }

    if (indent === 0) {
      const mFrom = impFromRe.exec(raw);
      if (mFrom) {
        const rawSpec = mFrom[1]!;
        const spec = rawSpec.startsWith(".")
          ? rawSpec.replace(/^(\.+)(.*)$/, (_, dots: string, rest: string) => {
              const prefix = dots.length === 1 ? "./" : "../".repeat(dots.length - 1);
              return prefix + rest.replace(/\./g, "/");
            })
          : rawSpec;
        for (const item of mFrom[2]!.split(",")) {
          const clean = item.trim();
          if (!clean) continue;
          const [orig, alias] = clean.split(/\s+as\s+/).map(s => s.trim());
          if (orig) imports.push({ spec, imported: orig, local: alias || orig, reexport: false });
        }
        continue;
      }
      const mBare = impBareRe.exec(raw);
      if (mBare) {
        for (const item of mBare[1]!.split(",")) {
          const clean = item.trim();
          if (!clean) continue;
          const [orig, alias] = clean.split(/\s+as\s+/).map(s => s.trim());
          if (orig) imports.push({ spec: orig, imported: "*", local: alias || orig, reexport: false });
        }
        continue;
      }
    }

    const owner = stack[stack.length - 1]!.node;
    callRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(raw)) !== null) {
      const nm = cm[1]!;
      if (!CALL_SKIP.has(nm) && nm !== owner.name) {
        owner.refs.push({ name: nm, kind: "calls", recv: "" });
      }
    }
  }
  while (stack.length > 1) {
    stack.pop()!.node.endLine = Math.max(1, lines.length);
  }
  for (const n of nodes) {
    const seen = new Set<string>();
    n.refs = n.refs.filter(r => {
      const k = `${r.kind}|${r.recv}|${r.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return { nodes, imports };
}

function extractRust(text: string): Extracted {
  const lines = text.split("\n");
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: Math.max(1, lines.length), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: { depth: number; node: RawNode }[] = [{ depth: -1, node: mod }];
  let depth = 0;
  const defRe = /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn|struct|trait|enum)\s+(\w+)/;
  const useRe = /^\s*(?:pub\s+)?use\s+([\w:]+)(?:::\{([^}]*)\})?;/;
  const callRe = /\b(\w+)\s*\(/g;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    const dm = defRe.exec(raw);
    if (dm) {
      const kind = dm[2] === "fn" ? "function" : dm[2]!;
      const node: RawNode = { name: dm[3]!, kind, startLine: i + 1, endLine: i + 1, exported: Boolean(dm[1]), refs: [] };
      nodes.push(node);
      stack.push({ depth, node });
    } else {
      const um = useRe.exec(raw);
      if (um) {
        const spec = um[1]!;
        if (um[2]) {
          for (const item of um[2].split(",")) {
            const sym = item.trim();
            if (sym) imports.push({ spec, imported: sym, local: sym, reexport: false });
          }
        } else {
          const leaf = spec.split("::").pop() || spec;
          imports.push({ spec, imported: leaf, local: leaf, reexport: false });
        }
      }
    }

    const owner = stack[stack.length - 1]!.node;
    callRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(raw)) !== null) {
      const nm = cm[1]!;
      if (!CALL_SKIP.has(nm) && nm !== owner.name) {
        owner.refs.push({ name: nm, kind: "calls", recv: "" });
      }
    }

    for (const ch of raw) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth = Math.max(0, depth - 1);
        while (stack.length > 1 && depth <= stack[stack.length - 1]!.depth) {
          stack.pop()!.node.endLine = i + 1;
        }
      }
    }
  }
  while (stack.length > 1) stack.pop()!.node.endLine = Math.max(1, lines.length);
  for (const n of nodes) {
    const seen = new Set<string>();
    n.refs = n.refs.filter(r => {
      const k = `${r.kind}|${r.recv}|${r.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return { nodes, imports };
}

function scriptKind(p: string): ts.ScriptKind {
  if (p.endsWith("x")) return p.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  return p.endsWith("js") || p.endsWith("mjs") || p.endsWith("cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** Receiver of a member call: 'this', an identifier name, or '' (plain call / complex receiver). */
function recvOf(e: ts.Expression): string {
  if (!ts.isPropertyAccessExpression(e)) return "";
  if (e.expression.kind === ts.SyntaxKind.ThisKeyword) return "this";
  return ts.isIdentifier(e.expression) ? e.expression.text : "#";
}

function calleeName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

export function extractScript(path: string, text: string): Extracted {
  if (PY_EXT.test(path)) return extractPython(text);
  if (RS_EXT.test(path)) return extractRust(text);
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, false, scriptKind(path));
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: line(sf.end), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: RawNode[] = [mod];
  const cur = () => stack[stack.length - 1]!;
  let anon = 0; // depth inside anonymous function bodies (callbacks) — locals there are not symbols
  const isExported = (n: ts.Node) =>
    !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));

  const declare = (name: string, kind: string, n: ts.Node, exported: boolean) => {
    const node: RawNode = { name, kind, startLine: line(n.getStart(sf)), endLine: line(n.end), exported, refs: [] };
    nodes.push(node);
    return node;
  };

  const visit = (n: ts.Node): void => {
    let pushed: RawNode | undefined;
    if (ts.isFunctionDeclaration(n) && n.name) pushed = declare(n.name.text, "function", n, isExported(n));
    else if (ts.isClassDeclaration(n) && n.name) {
      pushed = declare(n.name.text, "class", n, isExported(n));
      for (const h of n.heritageClauses ?? [])
        for (const t of h.types) {
          const nm = calleeName(t.expression);
          if (nm) pushed.refs.push({ name: nm, kind: "extends", recv: recvOf(t.expression) });
        }
    } else if ((ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) && ts.isIdentifier(n.name))
      pushed = declare(n.name.text, "method", n, false);
    else if (ts.isInterfaceDeclaration(n)) pushed = declare(n.name.text, "interface", n, isExported(n));
    else if (ts.isTypeAliasDeclaration(n)) pushed = declare(n.name.text, "type", n, isExported(n));
    else if (ts.isEnumDeclaration(n)) pushed = declare(n.name.text, "enum", n, isExported(n));
    else if (ts.isVariableStatement(n) && (anon > 0 || (cur().kind !== "module" && cur().kind !== "class"))) {
      // local variable inside a function/callback/initializer: not a symbol; refs attribute to the enclosing node
      for (const d of n.declarationList.declarations) if (d.initializer) visit(d.initializer);
      return;
    } else if (ts.isVariableStatement(n)) {
      const exp = isExported(n);
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const fnLike = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
        const node = declare(d.name.text, fnLike ? "function" : "variable", d, exp);
        stack.push(node);
        if (d.initializer) visit(d.initializer);
        stack.pop();
      }
      return;
    } else if (ts.isImportDeclaration(n) && n.importClause) {
      const c = n.importClause;
      const spec = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : "";
      if (c.name) imports.push({ spec, imported: "default", local: c.name.text, reexport: false });
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) imports.push({ spec, imported: "*", local: nb.name.text, reexport: false });
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements) imports.push({ spec, imported: (el.propertyName ?? el.name).text, local: el.name.text, reexport: false });
      return;
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      const ec = n.exportClause;
      if (!ec) imports.push({ spec, imported: "*", local: "*", reexport: true });
      else if (ts.isNamedExports(ec))
        for (const el of ec.elements) imports.push({ spec, imported: (el.propertyName ?? el.name).text, local: el.name.text, reexport: true });
      return;
    } else if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const nm = calleeName(n.expression);
      if (nm) cur().refs.push({ name: nm, kind: "calls", recv: recvOf(n.expression) });
    }
    const isAnon = !pushed && (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && !(n.parent && ts.isVariableDeclaration(n.parent));
    if (pushed) stack.push(pushed);
    if (isAnon) anon++;
    ts.forEachChild(n, visit);
    if (isAnon) anon--;
    if (pushed) stack.pop();
  };
  visit(sf);
  for (const n of nodes) {
    const seen = new Set<string>();
    n.refs = n.refs.filter((r) => {
      const k = `${r.kind}|${r.recv}|${r.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return { nodes, imports };
}
