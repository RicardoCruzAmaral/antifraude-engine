import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import {
  AnalyzeAntifraudUseCase,
  type AnalyzeAntifraudConfig,
} from "../src/application/useCases/analyzeAntifraud";
import { techTrailEnrichmentProvider } from "../src/infrastructure/providers/techtrail/techTrailEnrichmentProvider";
import { imeiInfoProvider } from "../src/infrastructure/providers/imeiInfo/imeiInfoProvider";
import {
  createImeiBlacklistProvider,
  resolveBlacklistServiceId,
} from "../src/infrastructure/providers/imeiInfo/imeiBlacklistProvider";
import { createSupabasePersistenceOrNull } from "../src/infrastructure/persistence/supabase/supabasePersistence";
import { createSupabaseCacheV2AdaptersOrNull } from "../src/infrastructure/persistence/supabase/cacheV2Adapters";
import { resolveCacheV2Config } from "../src/infrastructure/config/cacheV2Config";
import { createHmacLookupTokenServiceFromEnv } from "../src/infrastructure/security/hmacLookupTokenService";
import { consoleCacheV2ShadowTelemetry } from "../src/infrastructure/telemetry/consoleCacheV2ShadowTelemetry";
import type { CacheV2ShadowDependencies } from "../src/application/cacheV2/shadowWriter";
import type { TechTrailReadDependencies } from "../src/application/cacheV2/techTrailReader";
import type { ImeiReadDependencies } from "../src/application/cacheV2/imeiReader";
import type { ImeiBlacklistReadDependencies } from "../src/application/cacheV2/imeiBlacklistReader";
import type { AnalysisReplayReadDependencies } from "../src/application/cacheV2/analysisReplayReader";
import { resolveImeiLookupContext } from "../src/providers/imei";
import {
  InvalidBooleanEnvironmentError,
  parseBooleanEnv,
  resolveEnrichmentMode,
  type EnrichmentMode,
} from "../src/infrastructure/config/envParsers";
import { resolveDecisionScoreConfig } from "../src/domain/engine";

function envInt(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envStr(name: string, fallback: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function resolveConfig(): AnalyzeAntifraudConfig {
  return {
    supabaseMissingPolicy: envStr("SUPABASE_MISSING_POLICY", "continue"),
    enrichmentTimeoutMs: envInt("ENRICHMENT_TIMEOUT_MS", 4000),
    enrichmentMode: resolveEnrichmentMode(),
    enrichmentFailDecision:
      envStr("ENRICHMENT_FAIL_DECISION", "DECLINE") === "APPROVE" ? "APPROVE" : "DECLINE",
    imeiTimeoutMs: envInt("IMEI_TIMEOUT_MS", 20000),
    imeiPenalty: envInt("SCORE_IMEI_PROBLEM", 5),
    cacheTtlDaysApprove: envInt("CACHE_TTL_DAYS_APPROVE", envInt("CACHE_TTL_DAYS_APROVE", 30)),
    cacheTtlDaysDecline: envInt("CACHE_TTL_DAYS_DECLINE", 30),
    cacheTtlSecondsTechFail: envInt("CACHE_TTL_SECONDS_ON_TECH_FAIL", 300),
    imeiBlacklistV1Enabled: parseBooleanEnv("IMEI_BLACKLIST_V1_ENABLED", false),
    decisionScoreConfig: resolveDecisionScoreConfig(),
  };
}

type CacheV2Composition = {
  shadow?: CacheV2ShadowDependencies;
  techTrailRead?: TechTrailReadDependencies;
  imeiRead?: ImeiReadDependencies;
  imeiBlacklistRead?: ImeiBlacklistReadDependencies;
  replayRead?: AnalysisReplayReadDependencies;
  decisionCacheV1ReadEnabled: boolean;
};

function composeCacheV2(
  traceId: string,
  blacklistEnabled: boolean,
  blacklistService: string | null,
  enrichmentMode: EnrichmentMode
): CacheV2Composition {
  let config;
  try {
    config = resolveCacheV2Config();
  } catch (error) {
    console.error("[cache-v2-shadow] invalid configuration", error);
    consoleCacheV2ShadowTelemetry.record({
      name: "cache_v2_configuration_error",
      traceId,
      reason: "INVALID_CONFIGURATION",
    });
    if (error instanceof InvalidBooleanEnvironmentError) throw error;
    return { decisionCacheV1ReadEnabled: true };
  }
  if (!config.analysisReplayEnabled && !config.writeEnabled && !config.readTechTrailEnabled && !config.readImeiEnabled) {
    return { decisionCacheV1ReadEnabled: config.decisionCacheV1ReadEnabled };
  }

  let lookupTokenService = null;
  try {
    lookupTokenService = createHmacLookupTokenServiceFromEnv();
  } catch (error) {
    console.error("[cache-v2-shadow] HMAC unavailable", error);
    consoleCacheV2ShadowTelemetry.record({
      name: "cache_v2_configuration_error",
      traceId,
      reason: "HMAC_KEY_UNAVAILABLE",
    });
  }

  let adapters = null;
  try {
    adapters = createSupabaseCacheV2AdaptersOrNull();
  } catch (error) {
    console.error("[cache-v2-shadow] Supabase adapters unavailable", error);
    consoleCacheV2ShadowTelemetry.record({
      name: "cache_v2_configuration_error",
      traceId,
      reason: "PERSISTENCE_UNAVAILABLE",
    });
  }

  const versions = {
    cacheSchemaVersion: "cache-v2-schema-v1",
    techTrailProviderContractVersion: "techtrail-person-v1",
    techTrailNormalizerVersion: "techtrail-normalizer-v1",
    imeiProviderContractVersion: "imei-info-v1",
    imeiNormalizerVersion: "imei-normalizer-v2",
    imeiBlacklistProviderContractVersion: "imei-info-blacklist-v1",
    imeiBlacklistNormalizerVersion: "imei-blacklist-normalizer-v1",
  };
  const shadow: CacheV2ShadowDependencies | undefined = config.writeEnabled ? {
    analysisReplayRepository: adapters?.analysisReplayRepository ?? null,
    enrichmentEvidenceCache: adapters?.enrichmentEvidenceCache ?? null,
    imeiEvidenceCache: adapters?.imeiEvidenceCache ?? null,
    lookupTokenService,
    telemetry: consoleCacheV2ShadowTelemetry,
    techTrailTtlDays: config.techTrailTtlDays,
    imeiTtlDays: config.imeiTtlDays,
    replayTtlDays: config.replayTtlDays,
    versions,
  } : undefined;
  const replayRead: AnalysisReplayReadDependencies | undefined = config.analysisReplayEnabled ? {
    analysisReplayRepository: adapters?.analysisReplayRepository ?? null,
    lookupTokenService,
    telemetry: consoleCacheV2ShadowTelemetry,
    cacheSchemaVersion: versions.cacheSchemaVersion,
  } : undefined;
  const techTrailRead: TechTrailReadDependencies | undefined = config.readTechTrailEnabled ? {
    enrichmentEvidenceCache: adapters?.enrichmentEvidenceCache ?? null,
    lookupTokenService,
    telemetry: consoleCacheV2ShadowTelemetry,
    provider: enrichmentMode === "real" ? "techtrail" : "mock",
    providerContractVersion: versions.techTrailProviderContractVersion,
    normalizerVersion: versions.techTrailNormalizerVersion,
    cacheSchemaVersion: versions.cacheSchemaVersion,
  } : undefined;
  const imeiRead: ImeiReadDependencies | undefined = config.readImeiEnabled && !blacklistEnabled ? {
    imeiEvidenceCache: adapters?.imeiEvidenceCache ?? null,
    lookupTokenService,
    telemetry: consoleCacheV2ShadowTelemetry,
    provider: "imei_info",
    providerContractVersion: versions.imeiProviderContractVersion,
    normalizerVersion: versions.imeiNormalizerVersion,
    cacheSchemaVersion: versions.cacheSchemaVersion,
    resolveContext: resolveImeiLookupContext,
  } : undefined;
  const imeiBlacklistRead: ImeiBlacklistReadDependencies | undefined = config.readImeiEnabled && blacklistEnabled ? {
    imeiEvidenceCache: adapters?.imeiEvidenceCache ?? null,
    lookupTokenService,
    telemetry: consoleCacheV2ShadowTelemetry,
    provider: "imei_info",
    service: blacklistService,
    providerContractVersion: versions.imeiBlacklistProviderContractVersion,
    normalizerVersion: versions.imeiBlacklistNormalizerVersion,
    cacheSchemaVersion: versions.cacheSchemaVersion,
  } : undefined;
  return {
    shadow,
    techTrailRead,
    imeiRead,
    imeiBlacklistRead,
    replayRead,
    decisionCacheV1ReadEnabled: config.decisionCacheV1ReadEnabled,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAtMs = Date.now();
  const traceId = crypto.randomUUID();
  const persistence = createSupabasePersistenceOrNull();

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, traceId, error: "Method not allowed" });
    }

    const analyzeConfig = resolveConfig();
    const blacklistServiceId = resolveBlacklistServiceId(process.env.IMEI_BLACKLIST_SERVICE_ID);
    const blacklistProvider = createImeiBlacklistProvider(blacklistServiceId);
    const cacheV2 = composeCacheV2(
      traceId,
      analyzeConfig.imeiBlacklistV1Enabled === true,
      blacklistProvider.service,
      analyzeConfig.enrichmentMode
    );
    const useCase = new AnalyzeAntifraudUseCase({
      enrichmentProvider: techTrailEnrichmentProvider,
      imeiProvider: imeiInfoProvider,
      imeiBlacklistProvider: blacklistProvider,
      decisionCache: persistence?.decisionCache ?? null,
      decisionAuditRepository: persistence?.decisionAuditRepository ?? null,
      providerRawRepository: persistence?.providerRawRepository ?? null,
      cacheV2Shadow: cacheV2.shadow,
      cacheV2TechTrailRead: cacheV2.techTrailRead,
      cacheV2ImeiRead: cacheV2.imeiRead,
      cacheV2ImeiBlacklistRead: cacheV2.imeiBlacklistRead,
      cacheV2ReplayRead: cacheV2.replayRead,
      imeiBlacklistTelemetry: consoleCacheV2ShadowTelemetry,
    });
    const result = await useCase.execute({
      body: req.body,
      traceId,
      startedAtMs,
      config: {
        ...analyzeConfig,
        decisionCacheV1ReadEnabled: cacheV2.decisionCacheV1ReadEnabled,
      },
    });
    return res.status(result.statusCode).json(result.body);
  } catch (err: any) {
    console.error("[analyze] fatal", err);
    return res.status(500).json({
      ok: false,
      traceId,
      error: "FUNCTION_INVOCATION_FAILED",
      details: err?.message ?? String(err),
    });
  }
}
