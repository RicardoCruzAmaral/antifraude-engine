import type {
  AnalysisReplayRepository,
  CacheV2ShadowEvent,
  CacheV2ShadowTelemetry,
  EnrichmentEvidenceCache,
  ImeiEvidenceCache,
  LookupTokenService,
} from "../ports";
import type {
  InputSummary,
  NormalizedImeiResult,
} from "../../domain/contracts";
import { buildReplayInput } from "./replayInput";

export type CacheV2ShadowVersions = {
  cacheSchemaVersion: string;
  techTrailProviderContractVersion: string;
  techTrailNormalizerVersion: string;
  imeiProviderContractVersion: string;
  imeiNormalizerVersion: string;
};

export type CacheV2ShadowDependencies = {
  analysisReplayRepository: AnalysisReplayRepository | null;
  enrichmentEvidenceCache: EnrichmentEvidenceCache | null;
  imeiEvidenceCache: ImeiEvidenceCache | null;
  lookupTokenService: LookupTokenService | null;
  telemetry: CacheV2ShadowTelemetry;
  techTrailTtlDays: number;
  imeiTtlDays: number | null;
  replayTtlDays: number | null;
  versions: CacheV2ShadowVersions;
};

function addDays(iso: string, days: number) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function emit(dependencies: CacheV2ShadowDependencies, event: CacheV2ShadowEvent) {
  try {
    dependencies.telemetry.record(event);
  } catch (error) {
    console.error("[cache-v2-shadow] telemetry failed", error);
  }
}

export async function shadowWriteTechTrail(
  dependencies: CacheV2ShadowDependencies,
  input: { traceId: string; cpf: string; result: any; fetchedAt: string }
) {
  if (!input.result?.ok || !input.result?.summary) {
    emit(dependencies, { name: "cache_v2_techtrail_write_skipped", traceId: input.traceId, reason: "INVALID_OR_TECHNICAL_RESULT" });
    return;
  }
  if (!dependencies.lookupTokenService || !dependencies.enrichmentEvidenceCache) {
    emit(dependencies, { name: "cache_v2_techtrail_write_skipped", traceId: input.traceId, reason: "DEPENDENCY_UNAVAILABLE" });
    return;
  }
  try {
    await dependencies.enrichmentEvidenceCache.put({
      lookupToken: dependencies.lookupTokenService.tokenizeCpf(input.cpf),
      provider: String(input.result.provider ?? "techtrail"),
      normalizedEvidence: input.result.summary,
      fetchedAt: input.fetchedAt,
      expiresAt: addDays(input.fetchedAt, dependencies.techTrailTtlDays),
      providerContractVersion: dependencies.versions.techTrailProviderContractVersion,
      normalizerVersion: dependencies.versions.techTrailNormalizerVersion,
      cacheSchemaVersion: dependencies.versions.cacheSchemaVersion,
      completeness: "COMPLETE",
      rawReference: null,
    });
    emit(dependencies, { name: "cache_v2_techtrail_write_success", traceId: input.traceId });
  } catch (error) {
    console.error("[cache-v2-shadow] TechTrail write failed", error);
    emit(dependencies, { name: "cache_v2_techtrail_write_error", traceId: input.traceId, reason: "WRITE_FAILED" });
  }
}

export async function shadowWriteImei(
  dependencies: CacheV2ShadowDependencies,
  input: { traceId: string; imeiCode: string; result: NormalizedImeiResult; fetchedAt: string }
) {
  if (dependencies.imeiTtlDays === null) {
    emit(dependencies, { name: "cache_v2_imei_write_skipped", traceId: input.traceId, reason: "TTL_NOT_CONFIGURED" });
    return;
  }
  if (input.result.reason === "IMEI_FAIL" || input.result.timedOut) {
    emit(dependencies, { name: "cache_v2_imei_write_skipped", traceId: input.traceId, reason: "TECHNICAL_FAILURE" });
    return;
  }
  if (!dependencies.lookupTokenService || !dependencies.imeiEvidenceCache) {
    emit(dependencies, { name: "cache_v2_imei_write_skipped", traceId: input.traceId, reason: "DEPENDENCY_UNAVAILABLE" });
    return;
  }
  try {
    await dependencies.imeiEvidenceCache.put({
      lookupToken: dependencies.lookupTokenService.tokenizeImei(input.imeiCode),
      provider: input.result.provider,
      service: input.result.serviceId === null || input.result.serviceId === undefined
        ? "local-validation"
        : String(input.result.serviceId),
      normalizedEvidence: {
        reason: input.result.reason,
        httpStatus: input.result.httpStatus ?? null,
        brandExpected: input.result.brandExpected ?? null,
        brandReturned: input.result.brandReturned ?? null,
        serviceId: input.result.serviceId ?? null,
        summary: input.result.summary ?? null,
      },
      fetchedAt: input.fetchedAt,
      expiresAt: addDays(input.fetchedAt, dependencies.imeiTtlDays),
      providerContractVersion: dependencies.versions.imeiProviderContractVersion,
      normalizerVersion: dependencies.versions.imeiNormalizerVersion,
      cacheSchemaVersion: dependencies.versions.cacheSchemaVersion,
      completeness: "COMPLETE",
      rawReference: null,
    });
    emit(dependencies, { name: "cache_v2_imei_write_success", traceId: input.traceId });
  } catch (error) {
    console.error("[cache-v2-shadow] IMEI write failed", error);
    emit(dependencies, { name: "cache_v2_imei_write_error", traceId: input.traceId, reason: "WRITE_FAILED" });
  }
}

export async function shadowWriteReplay(
  dependencies: CacheV2ShadowDependencies,
  input: {
    traceId: string;
    inputSummary: InputSummary;
    ruleVersion: string;
    statusCode: number;
    responseBody: unknown;
    createdAt: string;
  }
) {
  if (dependencies.replayTtlDays === null) {
    emit(dependencies, { name: "cache_v2_replay_write_skipped", traceId: input.traceId, reason: "TTL_NOT_CONFIGURED" });
    return;
  }
  if (!dependencies.lookupTokenService || !dependencies.analysisReplayRepository) {
    emit(dependencies, { name: "cache_v2_replay_write_skipped", traceId: input.traceId, reason: "DEPENDENCY_UNAVAILABLE" });
    return;
  }
  try {
    await dependencies.analysisReplayRepository.put({
      proposalId: input.inputSummary.proposalId,
      inputHash: dependencies.lookupTokenService.hashRelevantInput(buildReplayInput(input.inputSummary)),
      ruleVersion: input.ruleVersion,
      cacheSchemaVersion: dependencies.versions.cacheSchemaVersion,
      result: { statusCode: input.statusCode, body: input.responseBody },
      createdAt: input.createdAt,
      expiresAt: addDays(input.createdAt, dependencies.replayTtlDays),
    });
    emit(dependencies, { name: "cache_v2_replay_write_success", traceId: input.traceId });
  } catch (error) {
    console.error("[cache-v2-shadow] replay write failed", error);
    emit(dependencies, { name: "cache_v2_replay_write_error", traceId: input.traceId, reason: "WRITE_FAILED" });
  }
}
