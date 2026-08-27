import type { Decision } from "../../domain/contracts";

export type DecisionCacheEntry = {
  cpf: string;
  decision: Decision;
  score: number | null;
  reasons: string[];
  ruleVersion: string;
  expiresAt: string;
};

export type DecisionCacheWrite = {
  cpf: string;
  decision: Decision;
  score: number | null;
  reasons: string[];
  ruleVersion: string;
  ttlKind: "days" | "seconds";
  ttlValue: number;
  updatedAtIso: string;
};

export interface DecisionCache {
  get(cpf: string): Promise<DecisionCacheEntry | null>;
  set(entry: DecisionCacheWrite): Promise<string | null>;
}
