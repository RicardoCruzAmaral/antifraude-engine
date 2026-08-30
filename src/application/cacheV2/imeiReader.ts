import type {
  CacheV2ShadowTelemetry,
  ImeiEvidence,
  ImeiEvidenceCache,
  LookupTokenService,
} from "../ports";
import type { ImeiBrand, NormalizedImeiResult } from "../../domain/contracts";

export type ImeiLookupContext = {
  normalizedImei: string;
  brandExpected: ImeiBrand;
  serviceId: number | null;
  service: string;
};

export type ImeiReadDependencies = {
  imeiEvidenceCache: ImeiEvidenceCache | null;
  lookupTokenService: LookupTokenService | null;
  telemetry: CacheV2ShadowTelemetry;
  provider: "imei_info";
  providerContractVersion: string;
  normalizerVersion: string;
  cacheSchemaVersion: string;
  resolveContext(input: { imeiCode: string; modeloDeclarado?: string | null }): ImeiLookupContext;
};

export type ImeiReadResult =
  | { state: "HIT"; evidence: ImeiEvidence; result: NormalizedImeiResult }
  | { state: "FALLBACK"; cacheState: string };

function record(dependencies: ImeiReadDependencies, event: Parameters<CacheV2ShadowTelemetry["record"]>[0]) {
  try { dependencies.telemetry.record(event); }
  catch { console.error("[cache-v2-read] telemetry failed"); }
}

function factualResult(value: unknown, context: ImeiLookupContext): NormalizedImeiResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const evidence = value as Record<string, any>;
  if (evidence.reason !== "IMEI_OK" && evidence.reason !== "IMEI_INVALID") return null;
  const brandReturned = typeof evidence.brandReturned === "string" ? evidence.brandReturned : null;
  if (evidence.reason === "IMEI_INVALID") {
    return {
      ok: false, provider: "imei_info", ms: 0, httpStatus: evidence.httpStatus ?? null,
      reason: "IMEI_INVALID", brandExpected: context.brandExpected, brandReturned: null,
      serviceId: context.serviceId, summary: null, raw: null,
    };
  }
  const mismatch = context.brandExpected !== "UNKNOWN" && !!brandReturned && context.brandExpected !== brandReturned;
  return {
    ok: !mismatch, provider: "imei_info", ms: 0, httpStatus: evidence.httpStatus ?? null,
    reason: mismatch ? "IMEI_BRAND_MISMATCH" : "IMEI_OK",
    brandExpected: context.brandExpected, brandReturned, serviceId: context.serviceId,
    summary: evidence.summary ?? null, raw: null,
  };
}

function compatibleHit(evidence: ImeiEvidence, dependencies: ImeiReadDependencies) {
  return evidence.completeness === "COMPLETE" &&
    evidence.provider === dependencies.provider &&
    evidence.providerContractVersion === dependencies.providerContractVersion &&
    evidence.normalizerVersion === dependencies.normalizerVersion &&
    evidence.cacheSchemaVersion === dependencies.cacheSchemaVersion &&
    Date.parse(evidence.expiresAt) > Date.now();
}

export async function readImeiEvidence(
  dependencies: ImeiReadDependencies,
  input: { traceId: string; imeiCode: string; modeloDeclarado?: string | null }
): Promise<ImeiReadResult> {
  if (!dependencies.lookupTokenService || !dependencies.imeiEvidenceCache) {
    record(dependencies, { name: "cache_v2_imei_read_bypass", traceId: input.traceId, reason: "DEPENDENCY_UNAVAILABLE" });
    return { state: "FALLBACK", cacheState: "BYPASS" };
  }
  try {
    const context = dependencies.resolveContext(input);
    const lookup = await dependencies.imeiEvidenceCache.get({
      lookupToken: dependencies.lookupTokenService.tokenizeImei(context.normalizedImei),
      provider: dependencies.provider,
      service: context.service,
      providerContractVersion: dependencies.providerContractVersion,
      normalizerVersion: dependencies.normalizerVersion,
      cacheSchemaVersion: dependencies.cacheSchemaVersion,
    });
    if (lookup.state === "HIT") {
      const result = compatibleHit(lookup.value, dependencies)
        ? factualResult(lookup.value.normalizedEvidence, context)
        : null;
      if (!result) {
        record(dependencies, { name: "cache_v2_imei_read_incompatible", traceId: input.traceId, reason: "HIT_VALIDATION_FAILED" });
        return { state: "FALLBACK", cacheState: "INCOMPATIBLE" };
      }
      record(dependencies, {
        name: "cache_v2_imei_read_hit", traceId: input.traceId,
        details: { ageMs: lookup.ageMs, fetchedAt: lookup.value.fetchedAt, rawReference: lookup.value.rawReference ?? null, provider: lookup.value.provider, service: lookup.value.service },
      });
      return { state: "HIT", evidence: lookup.value, result };
    }
    const names = {
      MISS: "cache_v2_imei_read_miss", EXPIRED: "cache_v2_imei_read_expired",
      INCOMPATIBLE: "cache_v2_imei_read_incompatible", BACKEND_ERROR: "cache_v2_imei_read_backend_error",
    } as const;
    record(dependencies, {
      name: names[lookup.state], traceId: input.traceId,
      reason: lookup.state === "INCOMPATIBLE" ? lookup.reason : lookup.state === "BACKEND_ERROR" ? lookup.errorCode : undefined,
    });
    return { state: "FALLBACK", cacheState: lookup.state };
  } catch {
    console.error("[cache-v2-read] IMEI lookup failed", { traceId: input.traceId, reason: "LOOKUP_FAILED" });
    record(dependencies, { name: "cache_v2_imei_read_backend_error", traceId: input.traceId, reason: "LOOKUP_FAILED" });
    return { state: "FALLBACK", cacheState: "BACKEND_ERROR" };
  }
}
