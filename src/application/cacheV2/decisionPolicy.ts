import crypto from "crypto";
import type { Decision } from "../../domain/contracts";
import type { DecisionScoreConfig } from "../../domain/engine/scoreConfig";

export type DecisionConfigSnapshot = {
  scoring: DecisionScoreConfig;
  imeiProblemScore: number;
  enrichmentMode: "off" | "mock" | "real";
  enrichmentFailDecision: Decision;
  enrichmentTimeoutMs: number;
  imeiTimeoutMs: number;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export function decisionConfigFingerprint(config: DecisionConfigSnapshot): string {
  const serialized = JSON.stringify(canonicalize(config));
  return crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
}
