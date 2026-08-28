import type { CacheLookup } from "./cacheLookup";

export type AnalysisReplayKey = {
  proposalId: string | null;
  inputHash: string;
  ruleVersion: string;
  cacheSchemaVersion: string;
};

export type AnalysisReplayResult = {
  statusCode: number;
  body: unknown;
};

export type AnalysisReplayEntry = AnalysisReplayKey & {
  result: AnalysisReplayResult;
  createdAt: string;
  expiresAt: string;
};

export interface AnalysisReplayRepository {
  get(key: AnalysisReplayKey): Promise<CacheLookup<AnalysisReplayEntry>>;
  put(entry: AnalysisReplayEntry): Promise<void>;
}
