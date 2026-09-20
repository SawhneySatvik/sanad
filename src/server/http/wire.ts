import type { z } from "zod";

// The JSON round trip turns Dates into ISO strings and class instances into their own fields; the
// schema then strips every key it does not name, so nothing reaches the wire by accident.
/** A service result -> the JSON the client receives, validated by `schema`; throws if the result does not fit it. */
export function toWire<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}
