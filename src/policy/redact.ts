const replacementSecret = "«redacted:secret»";
const replacementPii = "«redacted:pii»";

// Full RegExp metacharacter set. Omitting '*' here previously meant a secret containing '*'
// (common in generated passwords) compiled to a quantifier and was never redacted.
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceLiteral(value: string, literal: string, replacement: string): string {
  if (!literal) return value;
  return value.replace(new RegExp(escapeRegex(literal), "g"), replacement);
}

export class Redactor {
  private readonly secrets: string[];
  private readonly piiValues: string[];

  constructor(rules: { secrets: string[]; piiValues: string[] }) {
    this.secrets = [...rules.secrets].filter(Boolean).sort((a, b) => b.length - a.length);
    this.piiValues = [...rules.piiValues].filter(Boolean).sort((a, b) => b.length - a.length);
  }

  /** Register values discovered during a run before they can reach observability. */
  registerSecret(value: string | undefined): void {
    if (!value || this.secrets.includes(value)) return;
    this.secrets.push(value);
    this.secrets.sort((a, b) => b.length - a.length);
  }

  registerPii(value: string | undefined): void {
    if (!value || this.piiValues.includes(value)) return;
    this.piiValues.push(value);
    this.piiValues.sort((a, b) => b.length - a.length);
  }

  maskPii(value: string): string {
    if (value.length <= 2) return "***";
    return `${value[0]}${"*".repeat(value.length - 2)}${value[value.length - 1]}`;
  }

  redactString(value: string): string {
    let redacted = value;

    // Ordering is deliberate: secret literals are removed before PII and regex sweeps.
    for (const secret of this.secrets) {
      redacted = replaceLiteral(redacted, secret, replacementSecret);
    }
    for (const pii of this.piiValues) {
      redacted = replaceLiteral(redacted, pii, this.maskPii(pii));
    }

    redacted = redacted.replace(/\d{3}-\d{2}-\d{4}/g, replacementPii);
    redacted = redacted.replace(/\b(?:\d[ -]*?){13,16}\b/g, replacementPii);
    redacted = redacted.replace(/\b\d{9,}\b/g, replacementPii);
    redacted = redacted.replace(
      /(password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi,
      (match, key: string) => `${key}=«redacted:secret»`,
    );

    return redacted;
  }

  redactJson(value: unknown): unknown {
    if (typeof value === "string") return this.redactString(value);

    // Numbers are a real carrier for sensitive values: ParamSpec/OutputSpec both allow
    // "number" and "currency", so an extracted member id or balance legitimately arrives
    // as a JS number. Redacting only strings leaked those straight into artifacts and logs.
    // Redact via the string form; return the original number only when nothing changed, so
    // ordinary numerics (seq, durationMs, counts) keep their type.
    if (typeof value === "number" || typeof value === "bigint") {
      const asString = String(value);
      const redacted = this.redactString(asString);
      return redacted === asString ? value : redacted;
    }

    if (Array.isArray(value)) return value.map((item) => this.redactJson(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.redactJson(item)]),
      );
    }
    return value;
  }
}
