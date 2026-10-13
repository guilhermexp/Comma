// Executed by the backend projection regression against the real client parser.
import { readFileSync } from "node:fs";
import { recommendationSourceSchema } from "../../../recommendation-contract/src/index.ts";

const sources = JSON.parse(readFileSync(process.argv[2], "utf8"));
const outcomes = sources.map((source) => {
  const parsed = recommendationSourceSchema.safeParse(source);
  return {
    accepted: parsed.success,
    labelUnits: source.label.length,
    referenceRetained:
      parsed.success && parsed.data.connectionId === source.connectionId,
    issues: parsed.success
      ? []
      : parsed.error.issues.map(({ code, path, maximum }) => ({ code, path, maximum })),
  };
});
console.log(JSON.stringify(outcomes));
process.exitCode = outcomes.every(
  ({ accepted, referenceRetained }) => accepted && referenceRetained
)
  ? 0
  : 1;
