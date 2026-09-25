// Expressions for variables and dimensions: `width - 2 * t`, `18mm`,
// `max(300, depth / 2)`, `angle + 5deg`. Values are plain numbers in the
// document's base units, millimetres for lengths and degrees for angles, so a
// unit suffix converts: `2cm` is 20, `0.5rad` is 28.6479…
//
// The grammar is small on purpose: numbers with an optional unit, names,
// + - * / ^ and unary minus, parentheses, comparisons, `a ? b : c`, and a
// fixed list of functions. There is no access to anything else, so a
// document's expressions can be evaluated anywhere without risk.

export class ExpressionError extends Error {
  constructor(
    message: string,
    /** Character offset in the source where the problem was found. */
    readonly at: number,
  ) {
    super(message);
  }
}

/** Unit suffixes and the factor that converts them to base units. */
const units: Readonly<Record<string, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
  deg: 1,
  rad: 180 / Math.PI,
};

const functions: Readonly<Record<string, (...args: number[]) => number>> = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  sqrt: Math.sqrt,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  // Trigonometry takes and returns degrees, like every angle in a document.
  sin: (a) => Math.sin((a * Math.PI) / 180),
  cos: (a) => Math.cos((a * Math.PI) / 180),
  tan: (a) => Math.tan((a * Math.PI) / 180),
  asin: (v) => (Math.asin(v) * 180) / Math.PI,
  acos: (v) => (Math.acos(v) * 180) / Math.PI,
  atan: (v) => (Math.atan(v) * 180) / Math.PI,
  atan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI,
};
const constants: Readonly<Record<string, number>> = { pi: Math.PI };

export type Expression =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "name"; readonly name: string; readonly at: number }
  | {
      readonly kind: "unary";
      readonly operator: "-" | "!";
      readonly operand: Expression;
    }
  | {
      readonly kind: "binary";
      readonly operator: string;
      readonly left: Expression;
      readonly right: Expression;
    }
  | {
      readonly kind: "conditional";
      readonly test: Expression;
      readonly then: Expression;
      readonly otherwise: Expression;
    }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly args: readonly Expression[];
      readonly at: number;
    };

type Token =
  | { kind: "number"; value: number; at: number }
  | { kind: "name"; value: string; at: number }
  | { kind: "op"; value: string; at: number }
  | { kind: "end"; at: number };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const number = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(source.slice(i));
    if (number) {
      let value = Number(number[0]);
      let end = i + number[0].length;
      // A unit written right after a number (`18mm`, `2 cm`) scales it.
      const unit = /^\s*([a-z]+)/.exec(source.slice(end));
      if (unit && units[unit[1]!] !== undefined) {
        value *= units[unit[1]!]!;
        end += unit[0].length;
      }
      tokens.push({ kind: "number", value, at: i });
      i = end;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name) {
      tokens.push({ kind: "name", value: name[0], at: i });
      i += name[0].length;
      continue;
    }
    const op = /^(<=|>=|==|!=|&&|\|\||[-+*/^%(),?:<>!])/.exec(source.slice(i));
    if (op) {
      tokens.push({ kind: "op", value: op[0], at: i });
      i += op[0].length;
      continue;
    }
    throw new ExpressionError(`Unexpected "${c}"`, i);
  }
  tokens.push({ kind: "end", at: source.length });
  return tokens;
}

/** Parses an expression, or throws an ExpressionError naming where. */
export function parseExpression(source: string): Expression {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position]!;
  const isOp = (value: string) => {
    const token = peek();
    return token.kind === "op" && token.value === value;
  };
  const expect = (value: string) => {
    if (!isOp(value))
      throw new ExpressionError(`Expected "${value}"`, peek().at);
    position++;
  };
  const binary =
    (operators: readonly string[], next: () => Expression) =>
    (): Expression => {
      let left = next();
      for (;;) {
        const token = peek();
        if (token.kind !== "op" || !operators.includes(token.value))
          return left;
        position++;
        left = { kind: "binary", operator: token.value, left, right: next() };
      }
    };
  const primary = (): Expression => {
    const token = peek();
    if (token.kind === "number") {
      position++;
      return { kind: "number", value: token.value };
    }
    if (token.kind === "name") {
      position++;
      if (isOp("(")) {
        position++;
        const args: Expression[] = [];
        if (!isOp(")"))
          for (;;) {
            args.push(conditional());
            if (isOp(",")) position++;
            else break;
          }
        expect(")");
        return { kind: "call", name: token.value, args, at: token.at };
      }
      return { kind: "name", name: token.value, at: token.at };
    }
    if (isOp("(")) {
      position++;
      const inner = conditional();
      expect(")");
      return inner;
    }
    throw new ExpressionError(
      token.kind === "end" ? "Expression ends too early" : "Unexpected token",
      token.at,
    );
  };
  const unary = (): Expression => {
    if (isOp("-") || isOp("!")) {
      const operator = peek().kind === "op" && isOp("-") ? "-" : "!";
      position++;
      return { kind: "unary", operator, operand: unary() };
    }
    if (isOp("+")) {
      position++;
      return unary();
    }
    return power();
  };
  // Right-associative: 2^3^2 is 2^(3^2).
  const power = (): Expression => {
    const base = primary();
    if (!isOp("^")) return base;
    position++;
    return { kind: "binary", operator: "^", left: base, right: unary() };
  };
  const product = binary(["*", "/", "%"], unary);
  const sum = binary(["+", "-"], product);
  const comparison = binary(["<", ">", "<=", ">=", "==", "!="], sum);
  const and = binary(["&&"], comparison);
  const or = binary(["||"], and);
  const conditional = (): Expression => {
    const test = or();
    if (!isOp("?")) return test;
    position++;
    const then = conditional();
    expect(":");
    return { kind: "conditional", test, then, otherwise: conditional() };
  };
  const expression = conditional();
  if (peek().kind !== "end")
    throw new ExpressionError("Unexpected token", peek().at);
  return expression;
}

/** The names an expression reads, in order of first use. */
export function referencedNames(expression: Expression): string[] {
  const names: string[] = [];
  const visit = (node: Expression): void => {
    switch (node.kind) {
      case "name":
        if (!(node.name in constants) && !names.includes(node.name))
          names.push(node.name);
        return;
      case "unary":
        return visit(node.operand);
      case "binary":
        visit(node.left);
        return visit(node.right);
      case "conditional":
        visit(node.test);
        visit(node.then);
        return visit(node.otherwise);
      case "call":
        return node.args.forEach(visit);
      case "number":
        return;
    }
  };
  visit(expression);
  return names;
}

/** Evaluates a parsed expression. `lookup` returns a name's value, or
 * undefined when the name is unknown. Booleans are 1 and 0. */
export function evaluateExpression(
  expression: Expression,
  lookup: (name: string) => number | undefined,
): number {
  const evaluate = (node: Expression): number => {
    switch (node.kind) {
      case "number":
        return node.value;
      case "name": {
        if (node.name in constants) return constants[node.name]!;
        const value = lookup(node.name);
        if (value === undefined)
          throw new ExpressionError(`Unknown name "${node.name}"`, node.at);
        return value;
      }
      case "unary": {
        const value = evaluate(node.operand);
        return node.operator === "-" ? -value : value ? 0 : 1;
      }
      case "conditional":
        return evaluate(node.test)
          ? evaluate(node.then)
          : evaluate(node.otherwise);
      case "call": {
        const fn = functions[node.name];
        if (!fn)
          throw new ExpressionError(`Unknown function "${node.name}"`, node.at);
        return fn(...node.args.map(evaluate));
      }
      case "binary": {
        const a = evaluate(node.left);
        // && and || only evaluate their right side when they need it.
        if (node.operator === "&&")
          return a ? (evaluate(node.right) ? 1 : 0) : 0;
        if (node.operator === "||") return a ? 1 : evaluate(node.right) ? 1 : 0;
        const b = evaluate(node.right);
        switch (node.operator) {
          case "+":
            return a + b;
          case "-":
            return a - b;
          case "*":
            return a * b;
          case "/":
            return a / b;
          case "%":
            return a % b;
          case "^":
            return a ** b;
          case "<":
            return a < b ? 1 : 0;
          case ">":
            return a > b ? 1 : 0;
          case "<=":
            return a <= b ? 1 : 0;
          case ">=":
            return a >= b ? 1 : 0;
          case "==":
            return a === b ? 1 : 0;
          case "!=":
            return a !== b ? 1 : 0;
        }
        throw new Error(`Unhandled operator ${node.operator}`);
      }
    }
  };
  return evaluate(expression);
}

/** Parses and evaluates in one step. */
export function evaluate(
  source: string,
  lookup: (name: string) => number | undefined = () => undefined,
): number {
  return evaluateExpression(parseExpression(source), lookup);
}
