/**
 * Canonical object-shape check for values of type {@link unknown}.
 *
 * This is the single valid place to narrow `unknown` down to an object shape.
 * It is intentionally NOT a domain validator: it only confirms that the value
 * is a non-null object so that callers can read properties off it. Every call
 * site must then validate the individual properties and return a real domain
 * type, forming the pipeline:
 *
 *   unknown -> isRecord (object-shaped) -> validate properties -> domain type
 *
 * Do not redefine this helper locally. The `custom/no-is-record` lint rule
 * forbids local copies and inline `typeof x === "object"` checks so that all
 * object narrowing flows through here.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
