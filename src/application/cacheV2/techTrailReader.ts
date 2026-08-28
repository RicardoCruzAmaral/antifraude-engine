import type {
  CacheV2ShadowTelemetry,
  EnrichmentEvidence,
  EnrichmentEvidenceCache,
  LookupTokenService,
} from "../ports";

export type TechTrailReadDependencies = {
  enrichmentEvidenceCache: EnrichmentEvidenceCache | null;
  lookupTokenService: LookupTokenService | null;
  telemetry: CacheV2ShadowTelemetry;
  provider: string;
  providerContractVersion: string;
  normalizerVersion: string;
  cacheSchemaVersion: string;
};

export type TechTrailReadResult =
  | { state: "HIT"; evidence: EnrichmentEvidence }
  | { state: "FALLBACK"; cacheState: string };

function record(
  dependencies: TechTrailReadDependencies,
  event: Parameters<CacheV2ShadowTelemetry["record"]>[0]
) {
  try {
    dependencies.telemetry.record(event);
  } catch (error) {
    console.error("[cache-v2-read] telemetry failed", error);
  }
}

function compatibleHit(evidence: EnrichmentEvidence, dependencies: TechTrailReadDependencies) {
  return evidence.completeness === "COMPLETE" &&
    !!evidence.normalizedEvidence &&
    typeof evidence.normalizedEvidence === "object" &&
    !Array.isArray(evidence.normalizedEvidence) &&
    evidence.provider === dependencies.provider &&
    evidence.providerContractVersion === dependencies.providerContractVersion &&
    evidence.normalizerVersion === dependencies.normalizerVersion &&
    evidence.cacheSchemaVersion === dependencies.cacheSchemaVersion &&
    Date.parse(evidence.expiresAt) > Date.now();
}

export async function readTechTrailEvidence(
  dependencies: TechTrailReadDependencies,
  input: { traceId: string; cpf: string }
): Promise<TechTrailReadResult> {
  if (!dependencies.lookupTokenService || !dependencies.enrichmentEvidenceCache) {
    record(dependencies, {
      name: "cache_v2_techtrail_read_bypass",
      traceId: input.traceId,
      reason: "DEPENDENCY_UNAVAILABLE",
    });
    return { state: "FALLBACK", cacheState: "BYPASS" };
  }

  try {
    const lookupToken = dependencies.lookupTokenService.tokenizeCpf(input.cpf);
    const lookup = await dependencies.enrichmentEvidenceCache.get({
      lookupToken,
      provider: dependencies.provider,
      providerContractVersion: dependencies.providerContractVersion,
      normalizerVersion: dependencies.normalizerVersion,
      cacheSchemaVersion: dependencies.cacheSchemaVersion,
    });

    if (lookup.state === "HIT") {
      if (!compatibleHit(lookup.value, dependencies)) {
        record(dependencies, {
          name: "cache_v2_techtrail_read_incompatible",
          traceId: input.traceId,
          reason: "HIT_VALIDATION_FAILED",
        });
        return { state: "FALLBACK", cacheState: "INCOMPATIBLE" };
      }
      record(dependencies, {
        name: "cache_v2_techtrail_read_hit",
        traceId: input.traceId,
        details: {
          ageMs: lookup.ageMs,
          fetchedAt: lookup.value.fetchedAt,
          rawReference: lookup.value.rawReference ?? null,
        },
      });
      return { state: "HIT", evidence: lookup.value };
    }

    const names = {
      MISS: "cache_v2_techtrail_read_miss",
      EXPIRED: "cache_v2_techtrail_read_expired",
      INCOMPATIBLE: "cache_v2_techtrail_read_incompatible",
      BACKEND_ERROR: "cache_v2_techtrail_read_backend_error",
    } as const;
    record(dependencies, {
      name: names[lookup.state],
      traceId: input.traceId,
      reason: lookup.state === "INCOMPATIBLE"
        ? lookup.reason
        : lookup.state === "BACKEND_ERROR"
          ? lookup.errorCode
          : undefined,
    });
    return { state: "FALLBACK", cacheState: lookup.state };
  } catch (error) {
    console.error("[cache-v2-read] TechTrail lookup failed", error);
    record(dependencies, {
      name: "cache_v2_techtrail_read_backend_error",
      traceId: input.traceId,
      reason: "LOOKUP_FAILED",
    });
    return { state: "FALLBACK", cacheState: "BACKEND_ERROR" };
  }
}
