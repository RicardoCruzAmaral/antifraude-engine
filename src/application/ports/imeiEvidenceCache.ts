import type {
  CacheLookup,
  EvidenceCompleteness,
  EvidenceVersions,
} from "./cacheLookup";

export type ImeiEvidenceKey = EvidenceVersions & {
  lookupToken: string;
  provider: string;
  service: string;
};

export type ImeiEvidence = ImeiEvidenceKey & {
  normalizedEvidence: unknown;
  fetchedAt: string;
  expiresAt: string;
  completeness: EvidenceCompleteness;
  rawReference?: string | null;
};

export interface ImeiEvidenceCache {
  get(key: ImeiEvidenceKey): Promise<CacheLookup<ImeiEvidence>>;
  put(evidence: ImeiEvidence): Promise<void>;
}
