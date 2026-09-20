/**
 * Writer for SII definition files.
 *
 * SII is SCS' plain-text unit format. The game's parser is unforgiving about a
 * few things that are easy to get wrong by hand, and this module makes them
 * impossible: strings are checked, arrays use the `key[]:` form, `@include`
 * sits at column zero, and files carry the exact `SiiNunit` wrapper.
 */

export type SiiValue = string | number | boolean | readonly number[];

function formatValue(value: SiiValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`SII cannot represent ${value}`);
    return Number.isInteger(value) ? String(value) : formatFloat(value);
  }
  if (Array.isArray(value)) return `(${value.map((v) => formatFloat(Number(v))).join(", ")})`;
  const text = String(value);
  // The parser has no escape for a literal quote, so reject rather than emit a
  // file that silently truncates at the stray quote.
  if (text.includes('"')) {
    throw new Error(`SII string values cannot contain a double quote: ${JSON.stringify(text)}`);
  }
  return `"${text}"`;
}

/** Match Python's `%g`: shortest round-tripping form, trailing zeros dropped. */
function formatFloat(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toPrecision(6).replace(/0+$/, "").replace(/\.$/, "");
  return String(Number(fixed));
}

/** One `class_name : unit_name { ... }` block. */
export class SiiUnit {
  private readonly lines: string[] = [];

  constructor(
    readonly className: string,
    readonly unitName: string,
  ) {}

  set(key: string, value: SiiValue): this {
    this.lines.push(`\t${key}: ${formatValue(value)}`);
    return this;
  }

  /** Add one entry to an array attribute, i.e. `key[]: value`. */
  append(key: string, value: SiiValue): this {
    this.lines.push(`\t${key}[]: ${formatValue(value)}`);
    return this;
  }

  extend(key: string, values: Iterable<SiiValue>): this {
    for (const value of values) this.append(key, value);
    return this;
  }

  /**
   * Pull in a shared `.sui` fragment.
   *
   * `@include` must sit at column zero -- indenting it makes the parser treat
   * the line as an attribute and fail the whole unit.
   */
  include(suiName: string): this {
    this.lines.push(`@include "${suiName}"`);
    return this;
  }

  blank(): this {
    this.lines.push("");
    return this;
  }

  render(): string {
    return `${this.className}: ${this.unitName}\n{\n${this.lines.join("\n")}\n}\n`;
  }
}

/** A `SiiNunit { ... }` document holding one or more units. */
export class SiiFile {
  readonly units: SiiUnit[];

  constructor(...units: SiiUnit[]) {
    this.units = units;
  }

  add(unit: SiiUnit): SiiUnit {
    this.units.push(unit);
    return unit;
  }

  render(): string {
    return `SiiNunit\n{\n${this.units.map((u) => u.render()).join("\n")}}\n`;
  }
}

/** Render a `.sui` fragment: bare indented attributes, no unit wrapper. */
export function renderSui(attributes: ReadonlyArray<readonly [string, SiiValue]>): string {
  return attributes.map(([key, value]) => `\t${key}: ${formatValue(value)}`).join("\n") + "\n";
}
