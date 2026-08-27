import type { AnalysisSource, Decision, InputSummary } from "../../domain/contracts";

export type DecisionAudit = {
  traceId: string;
  cpf: string | null;
  source: AnalysisSource;
  cacheHit: boolean;
  decision: Decision;
  score: number | null;
  reasons: string[];
  ruleVersion: string;
  inputSummary: InputSummary | null;
  events: any[];
  latencyMs: number;
};

export interface DecisionAuditRepository {
  saveDecision(decision: DecisionAudit): Promise<void>;
}
