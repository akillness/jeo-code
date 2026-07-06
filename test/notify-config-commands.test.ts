import { test, expect } from "bun:test";
import { parseInThreadConfigCommand } from "../src/agent/notify/config-commands";

// --- /verbose, /lean ---

test("/verbose parses to a verbose verbosity change", () => {
  expect(parseInThreadConfigCommand("/verbose")).toEqual({ verbosity: "verbose" });
});

test("/lean parses to a lean verbosity change", () => {
  expect(parseInThreadConfigCommand("/lean")).toEqual({ verbosity: "lean" });
});

// --- /verbosity <arg> ---

test("/verbosity lean parses to a lean verbosity change", () => {
  expect(parseInThreadConfigCommand("/verbosity lean")).toEqual({ verbosity: "lean" });
});

test("/verbosity verbose parses to a verbose verbosity change", () => {
  expect(parseInThreadConfigCommand("/verbosity verbose")).toEqual({ verbosity: "verbose" });
});

test("/verbosity with an unrecognised argument is not a config command", () => {
  expect(parseInThreadConfigCommand("/verbosity bogus")).toBeUndefined();
});

test("/verbosity with no argument is not a config command", () => {
  expect(parseInThreadConfigCommand("/verbosity")).toBeUndefined();
});

// --- /redact <arg> ---

test("/redact on/true/1 all parse to redact:true", () => {
  expect(parseInThreadConfigCommand("/redact on")).toEqual({ redact: true });
  expect(parseInThreadConfigCommand("/redact true")).toEqual({ redact: true });
  expect(parseInThreadConfigCommand("/redact 1")).toEqual({ redact: true });
});

test("/redact off/false/0 all parse to redact:false", () => {
  expect(parseInThreadConfigCommand("/redact off")).toEqual({ redact: false });
  expect(parseInThreadConfigCommand("/redact false")).toEqual({ redact: false });
  expect(parseInThreadConfigCommand("/redact 0")).toEqual({ redact: false });
});

test("/redact with an unrecognised argument is not a config command", () => {
  expect(parseInThreadConfigCommand("/redact maybe")).toBeUndefined();
});

test("/redact with no argument is not a config command", () => {
  expect(parseInThreadConfigCommand("/redact")).toBeUndefined();
});

// --- case insensitivity (source lowercases both command and arg) ---

test("the command name is case-insensitive", () => {
  expect(parseInThreadConfigCommand("/VERBOSE")).toEqual({ verbosity: "verbose" });
  expect(parseInThreadConfigCommand("/VERBOSITY LEAN")).toEqual({ verbosity: "lean" });
});

test("the command argument is case-insensitive", () => {
  expect(parseInThreadConfigCommand("/Redact ON")).toEqual({ redact: true });
});

// --- non-command text ---

test("plain non-slash text is not a config command", () => {
  expect(parseInThreadConfigCommand("hello world")).toBeUndefined();
});

test("an empty string is not a config command", () => {
  expect(parseInThreadConfigCommand("")).toBeUndefined();
});

test("a lone slash is not a config command", () => {
  expect(parseInThreadConfigCommand("/")).toBeUndefined();
});

test("an unrecognised command is not a config command", () => {
  expect(parseInThreadConfigCommand("/unknown")).toBeUndefined();
});

test("an unrecognised command with an argument is still not a config command", () => {
  expect(parseInThreadConfigCommand("/unknown arg")).toBeUndefined();
});

// --- whitespace handling ---

test("leading/trailing whitespace around the command is trimmed before parsing", () => {
  expect(parseInThreadConfigCommand("  /verbose  ")).toEqual({ verbosity: "verbose" });
});

test("whitespace-only text is not a config command", () => {
  expect(parseInThreadConfigCommand("   ")).toBeUndefined();
});

// --- multiple spaces between command and arg (split(/\s+/) collapses runs) ---

test("multiple spaces between command and argument still parse correctly", () => {
  expect(parseInThreadConfigCommand("/redact    on")).toEqual({ redact: true });
});

// --- trailing tokens beyond the first arg are ignored (rest[0] only) ---

test("extra trailing words after a valid command+arg are ignored", () => {
  expect(parseInThreadConfigCommand("/verbose extra stuff")).toEqual({ verbosity: "verbose" });
});
