import { test, expect } from "bun:test";
import * as ts from "typescript";
import { findMatches, renderReplacement } from "../src/agent/ast-match";

function src(code: string): ts.SourceFile {
  return ts.createSourceFile("f.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function texts(pattern: string, code: string): string[] {
  const sf = src(code);
  return findMatches(pattern, sf).map(m => m.node.getText(sf));
}

test("$$$ (bare) matches call-arg fan-out but not a differently-named call", () => {
  const out = texts("console.log($$$)", `
console.log("a");
console.log("a", "b", "c");
console.error("nope");
`);
  expect(out).toEqual(['console.log("a")', 'console.log("a", "b", "c")']);
});

test("$$$NAME captures the argument list", () => {
  const sf = src("console.log(1, 2, 3);");
  const [m] = findMatches("console.log($$$ARGS)", sf);
  expect(m).toBeDefined();
  expect(m!.captures.multi.ARGS).toEqual(["1", "2", "3"]);
});

test("named-import destructuring: $$$IMPORTS matches only same-module named imports", () => {
  const out = texts('import { $$$IMPORTS } from "react"', `
import { useState, useEffect } from "react";
import React from "react";
import { x } from "other";
`);
  expect(out).toEqual(['import { useState, useEffect } from "react";']);
});

test("arrow-const pattern matches exported AND unexported declarations (modifier-list skip)", () => {
  const out = texts("const $NAME = ($$$ARGS) => $BODY", `
const greet = (name) => name.trim();
export const other = (a, b) => a + b;
function notThis() {}
`);
  expect(out.length).toBe(2);
  expect(out[0]).toContain("greet");
  expect(out[1]).toContain("other");
});

test("captures.single/.multi are populated for the arrow-const pattern", () => {
  const sf = src("const greet = (name) => name.trim();");
  const [m] = findMatches("const $NAME = ($$$ARGS) => $BODY", sf);
  expect(m!.captures.single).toEqual({ NAME: "greet", BODY: "name.trim()" });
  expect(m!.captures.multi).toEqual({ ARGS: ["name"] });
});

test("$_ wildcard receiver matches any callee but not a different method name", () => {
  const out = texts("logger.$_($$$ARGS)", `
logger.info("hi", 1);
logger.error("bad");
console.log("skip");
`);
  expect(out).toEqual(['logger.info("hi", 1)', 'logger.error("bad")']);
});

test("bare identifier pattern is an existence check across declaration and call sites", () => {
  const out = texts("processItems", `
function processItems(x) { return x; }
processItems(data);
notProcessItems();
`);
  expect(out.length).toBe(2);
});

test("class method structural pattern with typed wildcard parameter and return type", () => {
  const out = texts("class $_ { method($ARG: $_): $_ { $$$BODY } }", `
class Foo {
  method(x: number): string { return String(x); }
  other() {}
}
export class Bar {
  method(y: string): number { doStuff(); return 1; }
}
`);
  // Foo has an extra member ("other") so its member list doesn't match a
  // single-member pattern; only Bar (one member, same shape) matches.
  expect(out.length).toBe(1);
  expect(out[0]).toContain("class Bar");
  const sf = src(`export class Bar {
  method(y: string): number { doStuff(); return 1; }
}`);
  const [m] = findMatches("class $_ { method($ARG: $_): $_ { $$$BODY } }", sf);
  expect(m!.captures.single.ARG).toBe("y");
  expect(m!.captures.multi.BODY).toEqual(["doStuff();", "return 1;"]);
});

test("same metavariable used twice requires identical matched code", () => {
  const out = texts("assertEqual($A, $A)", `
assertEqual(x, x);
assertEqual(x, y);
`);
  expect(out).toEqual(["assertEqual(x, x)"]);
});

test("$A && $A() only matches when both operands are the same identifier", () => {
  const out = texts("$A && $A()", `
if (cb && cb()) { run(); }
maybeFn && maybeFn();
other && somethingElse();
`);
  expect(out).toEqual(["cb && cb()", "maybeFn && maybeFn()"]);
});

test("multi-statement pattern is rejected with a clear error", () => {
  const sf = src("a(); b();");
  expect(() => findMatches("a(); b();", sf)).toThrow(/exactly one top-level statement/);
});

test("renderReplacement substitutes single and multi captures, leaves unbound placeholders literal", () => {
  const out = renderReplacement("$A?.($$$ARGS)", {
    single: { A: "cb" },
    multi: { ARGS: ["1", "2"] },
  });
  expect(out).toBe("cb?.(1, 2)");
  const untouched = renderReplacement("$UNSET stays", { single: {}, multi: {} });
  expect(untouched).toBe("$UNSET stays");
});
