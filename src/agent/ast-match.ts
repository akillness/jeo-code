/**
 * Structural AST pattern matcher for TypeScript/JavaScript (gjc `ast_grep`/`ast_edit`
 * parity, scoped to TS/JS/TSX/JSX — jeo-code has zero native dependencies, so this is
 * a pure-TS reimplementation of ast-grep's metavariable matching against the
 * `typescript` compiler API's AST, NOT the real ast-grep binary and NOT multi-language.
 *
 * Pattern syntax (matches the `ast_grep`/`ast_edit` tool contract):
 *  - `$NAME`  — capture exactly ONE node; two occurrences of the same name in a
 *    pattern must match IDENTICAL source text (e.g. `assertEqual($A, $A)`).
 *  - `$_`     — wildcard, matches exactly one node without binding a capture.
 *  - `$$$NAME`/`$$$` — capture/ignore ZERO OR MORE sibling nodes in a LIST position
 *    (call arguments, array/object elements, statement lists, class members,
 *    named-import specifiers, parameter lists, ...). At most one `$$$`-style
 *    metavariable per list is supported.
 *
 * Implementation notes:
 *  - `ts.Node.forEachChild(cbNode, cbNodeArray)` is used to enumerate a node's
 *    children in canonical source order, distinguishing single-child "slots" from
 *    list ("NodeArray") slots — this is what lets `$$$` bind a variable-length
 *    span instead of a single node.
 *  - A metavariable identifier is frequently parsed WRAPPED in a structural node
 *    rather than standing bare — e.g. `($$$ARGS)` is a lone `ParameterDeclaration`
 *    whose `.name` is the identifier, `{ $$$IMPORTS }` is a lone `ImportSpecifier`,
 *    `: $_` is a `TypeReferenceNode`, `{ $$$BODY }` is a `Block` containing one
 *    `ExpressionStatement`. `unwrapBareWrapper()` sees through these SPECIFIC,
 *    well-known "no extra shape" wrappers so metavariable detection is not
 *    accidentally defeated by the parser's own AST shape.
 *  - Structural comparison otherwise requires the SAME `SyntaxKind` and recurses
 *    slot-by-slot. A pattern is allowed to OMIT trailing optional slots the
 *    candidate has (e.g. no `else` branch, no return type) and to be missing a
 *    LEADING/MIDDLE list-shaped slot the candidate has (typically `modifiers`/
 *    `decorators`, e.g. matching un-exported AND exported declarations with the
 *    same pattern) — up to a small bounded number of skipped candidate slots.
 */
import * as ts from "typescript";

export type MetaKind = "single" | "multi" | "wild" | "wildmulti";
export interface Meta { kind: MetaKind; name: string }

function unwrapBareWrapper(node: ts.Node): ts.Node | null {
  if (ts.isParameter(node) && ts.isIdentifier(node.name) && !node.type && !node.initializer
      && !node.questionToken && !node.dotDotDotToken && (!node.modifiers || node.modifiers.length === 0)) {
    return node.name;
  }
  if (ts.isImportSpecifier(node) && !node.propertyName && !node.isTypeOnly) return node.name;
  if (ts.isExportSpecifier(node) && !node.propertyName && !node.isTypeOnly) return node.name;
  if (ts.isBindingElement(node) && !node.propertyName && !node.initializer && !node.dotDotDotToken && ts.isIdentifier(node.name)) return node.name;
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !node.typeArguments) return node.typeName;
  if (ts.isExpressionStatement(node)) return node.expression;
  if (ts.isShorthandPropertyAssignment(node) && !node.objectAssignmentInitializer) return node.name;
  return null;
}

/** Classify a (possibly wrapper-unwrapped) node as a metavariable, or `null` for
 *  an ordinary AST node that must be matched structurally. */
export function metaOf(node: ts.Node): Meta | null {
  const inner = unwrapBareWrapper(node);
  if (inner) return metaOf(inner);
  if (!ts.isIdentifier(node)) return null;
  const t = node.text;
  if (t === "$_") return { kind: "wild", name: "_" };
  if (t === "$$$") return { kind: "wildmulti", name: "_" };
  const m3 = /^\$\$\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(t);
  if (m3) return { kind: "multi", name: m3[1]! };
  const m1 = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(t);
  if (m1) return { kind: "single", name: m1[1]! };
  return null;
}

export interface Bindings {
  single: Map<string, string>;
  multi: Map<string, string[]>;
}

function newBindings(): Bindings {
  return { single: new Map(), multi: new Map() };
}

type Slot = { kind: "node"; node: ts.Node } | { kind: "list"; nodes: readonly ts.Node[] };

function slotsOf(node: ts.Node): Slot[] {
  const out: Slot[] = [];
  node.forEachChild(
    child => { out.push({ kind: "node", node: child }); return undefined; },
    arr => { out.push({ kind: "list", nodes: arr }); return undefined; },
  );
  return out;
}

function leafText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return node.text;
  return undefined;
}

/** How many candidate-only slots (e.g. `export`/decorators the pattern omitted) a
 *  single structural comparison may skip over before giving up. */
const MAX_SLOT_SKIPS = 2;

function matchNode(pattern: ts.Node, patternSf: ts.SourceFile, candidate: ts.Node, candidateSf: ts.SourceFile, b: Bindings): boolean {
  const meta = metaOf(pattern);
  if (meta) {
    if (meta.kind === "wild") return true;
    if (meta.kind === "single") {
      const text = candidate.getText(candidateSf).trim();
      const prev = b.single.get(meta.name);
      if (prev !== undefined) return prev === text;
      b.single.set(meta.name, text);
      return true;
    }
    // `$$$NAME`/`$$$` reached outside a list slot (unusual pattern shape) — fall back
    // to treating it as a single capture of the whole candidate rather than failing.
    const text = candidate.getText(candidateSf).trim();
    if (meta.kind === "multi") {
      const prev = b.multi.get(meta.name);
      if (prev !== undefined) return prev.join(" ") === text;
      b.multi.set(meta.name, [text]);
    }
    return true;
  }
  if (pattern.kind !== candidate.kind) return false;
  const lt = leafText(pattern);
  if (lt !== undefined) return lt === leafText(candidate);

  const pSlots = slotsOf(pattern);
  const cSlots = slotsOf(candidate);
  let pi = 0, ci = 0, skips = 0;
  while (pi < pSlots.length) {
    const ps = pSlots[pi]!;
    if (ci >= cSlots.length) return false;
    const cs = cSlots[ci]!;
    if (ps.kind === cs.kind) {
      const ok = ps.kind === "list"
        ? matchList(ps.nodes, patternSf, (cs as { kind: "list"; nodes: readonly ts.Node[] }).nodes, candidateSf, b)
        : matchNode((ps as { kind: "node"; node: ts.Node }).node, patternSf, (cs as { kind: "node"; node: ts.Node }).node, candidateSf, b);
      if (!ok) {
        if (skips < MAX_SLOT_SKIPS && ci + 1 < cSlots.length) { skips++; ci++; continue; }
        return false;
      }
      pi++; ci++;
      continue;
    }
    // Slot-KIND mismatch (list vs single) at this relative position — most commonly a
    // `modifiers`/`decorators` list the candidate has and the pattern omitted. Skip the
    // candidate slot and retry the SAME pattern slot against the next one.
    if (skips < MAX_SLOT_SKIPS) { skips++; ci++; continue; }
    return false;
  }
  return true; // trailing extra candidate slots are fine — unspecified optional parts
}

function matchList(patternNodes: readonly ts.Node[], patternSf: ts.SourceFile, candidateNodes: readonly ts.Node[], candidateSf: ts.SourceFile, b: Bindings): boolean {
  const idx = patternNodes.findIndex(n => { const m = metaOf(n); return m?.kind === "multi" || m?.kind === "wildmulti"; });
  if (idx === -1) {
    if (patternNodes.length !== candidateNodes.length) return false;
    for (let i = 0; i < patternNodes.length; i++) {
      if (!matchNode(patternNodes[i]!, patternSf, candidateNodes[i]!, candidateSf, b)) return false;
    }
    return true;
  }
  const prefixLen = idx;
  const suffixLen = patternNodes.length - idx - 1;
  if (candidateNodes.length < prefixLen + suffixLen) return false;
  for (let i = 0; i < prefixLen; i++) {
    if (!matchNode(patternNodes[i]!, patternSf, candidateNodes[i]!, candidateSf, b)) return false;
  }
  for (let i = 0; i < suffixLen; i++) {
    if (!matchNode(patternNodes[patternNodes.length - 1 - i]!, patternSf, candidateNodes[candidateNodes.length - 1 - i]!, candidateSf, b)) return false;
  }
  const middle = candidateNodes.slice(prefixLen, candidateNodes.length - suffixLen);
  const meta = metaOf(patternNodes[idx]!)!;
  if (meta.kind === "multi") {
    const texts = middle.map(n => n.getText(candidateSf).trim());
    const prev = b.multi.get(meta.name);
    if (prev !== undefined) return prev.join(",") === texts.join(",");
    b.multi.set(meta.name, texts);
  }
  return true;
}

/** Parse a pattern string to a single matchable node. Multi-statement snippets are
 *  rejected with a clear error — wrap them in a block/valid context instead (same
 *  discipline as real ast-grep). A bare expression statement is unwrapped to its
 *  expression so `$A && $A()` matches an Expression, not only an ExpressionStatement. */
export function parsePattern(src: string): { node: ts.Node; sf: ts.SourceFile } {
  const sf = ts.createSourceFile("__pattern__.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (sf.statements.length !== 1) {
    throw new Error(`pattern must parse to exactly one top-level statement (got ${sf.statements.length}) — wrap multi-statement snippets in a block or valid context`);
  }
  let node: ts.Node = sf.statements[0]!;
  if (ts.isExpressionStatement(node)) node = node.expression;
  return { node, sf };
}

export interface MatchCaptures {
  single: Record<string, string>;
  multi: Record<string, string[]>;
}

export interface MatchResult {
  node: ts.Node;
  captures: MatchCaptures;
}

/** Find every non-overlapping-by-construction match of `patternSrc` in `sourceFile`.
 *  A fast prefilter only attempts nodes whose `SyntaxKind` equals the pattern's root
 *  kind (unless the pattern root is itself a bare metavariable). */
export function findMatches(patternSrc: string, sourceFile: ts.SourceFile): MatchResult[] {
  const { node: patternNode, sf: patternSf } = parsePattern(patternSrc);
  const patternIsBareMeta = metaOf(patternNode) !== null;
  const out: MatchResult[] = [];
  const visit = (node: ts.Node) => {
    if (patternIsBareMeta || node.kind === patternNode.kind) {
      const b = newBindings();
      if (matchNode(patternNode, patternSf, node, sourceFile, b)) {
        out.push({ node, captures: { single: Object.fromEntries(b.single), multi: Object.fromEntries(b.multi) } });
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return out;
}

/** Render a replacement template, substituting `$NAME`/`$$$NAME` with their bound
 *  capture text (multi-captures join with ", "). An unbound metavariable (including
 *  `$_`/`$$$`, which never bind) is left as literal text in the output. */
export function renderReplacement(template: string, captures: MatchCaptures): string {
  return template.replace(/\$\$\$([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, multiName?: string, singleName?: string) => {
    if (multiName !== undefined) {
      const vals = captures.multi[multiName];
      return vals !== undefined ? vals.join(", ") : whole;
    }
    if (singleName !== undefined) {
      const val = captures.single[singleName];
      return val !== undefined ? val : whole;
    }
    return whole;
  });
}
