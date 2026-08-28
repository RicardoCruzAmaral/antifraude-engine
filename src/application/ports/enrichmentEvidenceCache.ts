import type {
  CacheLookup,
  EvidenceCompleteness,
  EvidenceVersions,
} from "./cacheLookup";

export type EnrichmentEvidenceKey = EvidenceVersions & {
  lookupToken: string;
  provider: string;
};

export type EnrichmentEvidence = EnrichmentEvidenceKey & {
  normalizedEvidence: unknown;
  fetchedAt: string;
  expiresAt: string;
  completeness: EvidenceCompleteness;
  rawReference?: string | null;
};

export interface EnrichmentEvidenceCache {
  get(key: EnrichmentEvidenceKey): Promise<CacheLookup<EnrichmentEvidence>>;
  put(evidence: EnrichmentEvidence): Promise<void>;
}
