/**
 * Parser for the SNBT text the server prints in `data get` replies, e.g.
 *   [{count: 1, Slot: 0b, id: "minecraft:crafting_table", components: {"minecraft:damage": 3}}]
 * Numbers lose their type suffix (b, s, l, f, d); typed arrays ([B; ...], [I; ...], [L; ...])
 * become plain number arrays.
 */

export type SnbtValue = number | string | boolean | SnbtValue[] | { [key: string]: SnbtValue };

class Parser {
  private pos = 0;
  constructor(private readonly text: string) {}

  parse(): SnbtValue {
    const value = this.value();
    this.ws();
    if (this.pos !== this.text.length) this.fail('unexpected trailing text');
    return value;
  }

  private fail(message: string): never {
    throw new Error(`SNBT parse error at ${this.pos}: ${message} in "${this.text.slice(0, 200)}"`);
  }

  private ws(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  private peek(): string {
    return this.text[this.pos];
  }

  private value(): SnbtValue {
    this.ws();
    const ch = this.peek();
    if (ch === '{') return this.compound();
    if (ch === '[') return this.list();
    if (ch === '"' || ch === "'") return this.quoted();
    return this.bare();
  }

  private compound(): { [key: string]: SnbtValue } {
    const out: { [key: string]: SnbtValue } = {};
    this.pos++; // {
    this.ws();
    if (this.peek() === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      const key = this.peek() === '"' || this.peek() === "'" ? this.quoted() : this.bareToken(false);
      this.ws();
      if (this.peek() !== ':') this.fail(`expected ':' after key ${key}`);
      this.pos++;
      out[key] = this.value();
      this.ws();
      const next = this.peek();
      this.pos++;
      if (next === '}') return out;
      if (next !== ',') this.fail(`expected ',' or '}' but got '${next}'`);
    }
  }

  private list(): SnbtValue[] {
    this.pos++; // [
    this.ws();
    const typed = this.text.slice(this.pos).match(/^([BIL])\s*;/);
    if (typed) this.pos += typed[0].length;
    const out: SnbtValue[] = [];
    this.ws();
    if (this.peek() === ']') {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const next = this.peek();
      this.pos++;
      if (next === ']') return out;
      if (next !== ',') this.fail(`expected ',' or ']' but got '${next}'`);
    }
  }

  private quoted(): string {
    const quote = this.peek();
    this.pos++;
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos++];
      if (ch === '\\') {
        const escaped = this.text[this.pos++];
        out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
      } else if (ch === quote) {
        return out;
      } else {
        out += ch;
      }
    }
    this.fail('unterminated string');
  }

  /** Unquoted token. Keys stop at ':'; values may contain it (e.g. a bare minecraft:stone). */
  private bareToken(allowColon = true): string {
    const start = this.pos;
    const allowed = allowColon ? /[A-Za-z0-9_\-.+:]/ : /[A-Za-z0-9_\-.+]/;
    while (this.pos < this.text.length && allowed.test(this.text[this.pos])) this.pos++;
    if (this.pos === start) this.fail('expected a value');
    return this.text.slice(start, this.pos);
  }

  private bare(): SnbtValue {
    const token = this.bareToken();
    if (token === 'true') return true;
    if (token === 'false') return false;
    const numeric = token.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([bBsSlLfFdD])?$/);
    if (numeric) return Number(numeric[1]);
    return token;
  }
}

export function parseSnbt(text: string): SnbtValue {
  return new Parser(text.trim()).parse();
}

/**
 * Extracts the value from a `data get ...` reply such as
 * "dragonai has the following entity data: [6.5d, 68.0d, 44.5d]".
 * Returns null when the server reports that the target does not exist.
 */
export function parseDataGetReply(reply: string): SnbtValue | null {
  const marker = reply.match(/has the following (?:entity|block|storage) data: /);
  if (!marker || marker.index === undefined) return null;
  return parseSnbt(reply.slice(marker.index + marker[0].length));
}
