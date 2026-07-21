/**
 * `calc` tool — evaluate one or more arithmetic expressions (gjc parity:
 * `packages/coding-agent/src/tools/calculator.ts`, ported for jeo's plain
 * `ToolResult` contract; the tokenizer/parser/evaluator below are a faithful
 * port of gjc's recursive-descent implementation, verified against a direct
 * read of the real, public gajae-code source — TUI rendering is jeo's own,
 * gjc's bespoke `Component`/`Theme` renderer doesn't apply here).
 *
 * Supports: decimal (123, 3.14, .5), scientific notation (1e10, 2.5E-3),
 * hex (0xFF), binary (0b1010), octal (0o755) literals; +, -, *, /, %, and
 * right-associative ** (exponentiation); parentheses; unary +/-.
 */
import type { ToolResult } from "./tools";

/** Supported arithmetic operators (** is exponentiation). */
type Operator = "+" | "-" | "*" | "/" | "%" | "**";

type Token =
  | { type: "number"; value: number; raw: string }
  | { type: "operator"; value: Operator }
  | { type: "paren"; value: "(" | ")" };

export interface CalcRequest {
  expression: string;
  /** Prefix text prepended to the formatted result (e.g. "total: "). */
  prefix?: string;
  /** Suffix text appended to the formatted result (e.g. " USD"). */
  suffix?: string;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}
function isHexDigit(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}
function isBinaryDigit(ch: string): boolean {
  return ch === "0" || ch === "1";
}
function isOctalDigit(ch: string): boolean {
  return ch >= "0" && ch <= "7";
}

/**
 * Tokenize a math expression into numbers, operators, and parentheses.
 * Number formats: decimal, scientific (1e10), hex (0x), binary (0b), octal (0o).
 */
export function tokenizeExpression(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i]!;

    if (ch.trim() === "") { i += 1; continue; }

    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch });
      i += 1;
      continue;
    }

    // Check ** before single * to handle exponentiation.
    if (ch === "*" && expression[i + 1] === "*") {
      tokens.push({ type: "operator", value: "**" });
      i += 2;
      continue;
    }

    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%") {
      tokens.push({ type: "operator", value: ch });
      i += 1;
      continue;
    }

    // Number parsing: starts with a digit, or a decimal point followed by one.
    const next = expression[i + 1];
    const numberStart = isDigit(ch) || (ch === "." && next !== undefined && isDigit(next));
    if (!numberStart) {
      throw new Error(`Invalid character "${ch}" in expression`);
    }

    const start = i;

    // Prefixed literals: 0x (hex), 0b (binary), 0o (octal).
    if (ch === "0" && next !== undefined) {
      const prefix = next.toLowerCase();
      if (prefix === "x" || prefix === "b" || prefix === "o") {
        i += 2;
        let hasDigit = false;
        while (i < expression.length) {
          const digit = expression[i]!;
          const valid = prefix === "x" ? isHexDigit(digit) : prefix === "b" ? isBinaryDigit(digit) : isOctalDigit(digit);
          if (!valid) break;
          hasDigit = true;
          i += 1;
        }
        if (!hasDigit) throw new Error(`Invalid numeric literal starting at "${expression.slice(start, i)}"`);
        const raw = expression.slice(start, i);
        const value = Number(raw); // JS Number() handles 0x/0b/0o natively.
        if (!Number.isFinite(value)) throw new Error(`Invalid number "${raw}"`);
        tokens.push({ type: "number", value, raw });
        continue;
      }
    }

    // Decimal integer part.
    let hasDigits = false;
    while (i < expression.length && isDigit(expression[i]!)) { hasDigits = true; i += 1; }

    // Fractional part.
    if (expression[i] === ".") {
      i += 1;
      while (i < expression.length && isDigit(expression[i]!)) { hasDigits = true; i += 1; }
    }

    if (!hasDigits) throw new Error(`Invalid number starting at "${expression.slice(start, i + 1)}"`);

    // Scientific notation exponent (1e10, 2.5E-3).
    if (expression[i] === "e" || expression[i] === "E") {
      i += 1;
      if (expression[i] === "+" || expression[i] === "-") i += 1;
      let hasExponentDigits = false;
      while (i < expression.length && isDigit(expression[i]!)) { hasExponentDigits = true; i += 1; }
      if (!hasExponentDigits) throw new Error(`Invalid exponent in "${expression.slice(start, i)}"`);
    }

    const raw = expression.slice(start, i);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid number "${raw}"`);
    tokens.push({ type: "number", value, raw });
  }

  return tokens;
}

/**
 * Recursive-descent parser. Precedence (lowest to highest): +/-, then
 * `* / %`, then unary +/-, then `**` (right-associative), then parens/literals.
 */
class ExpressionParser {
  #index = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.#parseExpression();
    if (this.#index < this.tokens.length) throw new Error("Unexpected token in expression");
    return value;
  }

  /** Left-associative: 1 - 2 - 3 = (1 - 2) - 3. */
  #parseExpression(): number {
    let value = this.#parseTerm();
    for (;;) {
      if (this.#matchOperator("+")) { value += this.#parseTerm(); continue; }
      if (this.#matchOperator("-")) { value -= this.#parseTerm(); continue; }
      break;
    }
    return value;
  }

  /** Left-associative: 8 / 4 / 2 = (8 / 4) / 2. */
  #parseTerm(): number {
    let value = this.#parseUnary();
    for (;;) {
      if (this.#matchOperator("*")) { value *= this.#parseUnary(); continue; }
      if (this.#matchOperator("/")) { value /= this.#parseUnary(); continue; }
      if (this.#matchOperator("%")) { value %= this.#parseUnary(); continue; }
      break;
    }
    return value;
  }

  /** Recursive to handle chained unary: --x, +-x. */
  #parseUnary(): number {
    if (this.#matchOperator("+")) return this.#parseUnary();
    if (this.#matchOperator("-")) return -this.#parseUnary();
    return this.#parsePower();
  }

  /** Right-associative: 2 ** 3 ** 2 = 2 ** (3 ** 2) = 512, via recursion on the RHS. */
  #parsePower(): number {
    let value = this.#parsePrimary();
    if (this.#matchOperator("**")) value = value ** this.#parsePower();
    return value;
  }

  #parsePrimary(): number {
    const token = this.#peek();
    if (!token) throw new Error("Unexpected end of expression");
    if (token.type === "number") { this.#index += 1; return token.value; }
    if (token.type === "paren" && token.value === "(") {
      this.#index += 1;
      const value = this.#parseExpression();
      if (!this.#matchParen(")")) throw new Error("Missing closing parenthesis");
      return value;
    }
    throw new Error("Unexpected token in expression");
  }

  #matchOperator(value: Operator): boolean {
    const token = this.tokens[this.#index];
    if (token && token.type === "operator" && token.value === value) { this.#index += 1; return true; }
    return false;
  }

  #matchParen(value: "(" | ")"): boolean {
    const token = this.tokens[this.#index];
    if (token && token.type === "paren" && token.value === value) { this.#index += 1; return true; }
    return false;
  }

  #peek(): Token | undefined {
    return this.tokens[this.#index];
  }
}

/** Evaluate a math expression string. Throws on syntax errors, empty
 *  expressions, or non-finite results (Infinity/NaN, e.g. `1/0`). */
export function evaluateExpression(expression: string): number {
  const tokens = tokenizeExpression(expression);
  if (tokens.length === 0) throw new Error("Expression is empty");
  const value = new ExpressionParser(tokens).parse();
  if (!Number.isFinite(value)) throw new Error("Expression result is not a finite number");
  return Object.is(value, -0) ? 0 : value; // normalize -0 to 0
}

function formatResult(value: number): string {
  return String(value);
}

/** `calc` tool entrypoint: evaluate one or more expressions, each optionally
 *  wrapped in prefix/suffix text (e.g. `{expression:"3*7", prefix:"total: "}`). */
export async function calcTool(calculations: CalcRequest[]): Promise<ToolResult> {
  if (!Array.isArray(calculations) || calculations.length === 0) {
    return { success: false, output: "", error: "calc: 'calculations' must be a non-empty array of { expression }" };
  }
  try {
    const lines = calculations.map(calc => {
      const value = evaluateExpression(calc.expression);
      return `${calc.prefix ?? ""}${formatResult(value)}${calc.suffix ?? ""}`;
    });
    return { success: true, output: lines.join("\n") };
  } catch (e) {
    return { success: false, output: "", error: `calc: ${e instanceof Error ? e.message : String(e)}` };
  }
}
