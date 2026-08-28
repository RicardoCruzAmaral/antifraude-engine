import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import {
  AnalyzeAntifraudUseCase,
  type AnalyzeAntifraudConfig,
} from "../src/application/useCases/analyzeAntifraud";
import { techTrailEnrichmentProvider } from "../src/infrastructure/providers/techtrail/techTrailEnrichmentProvider";
import { imeiInfoProvider } from "../src/infrastructure/providers/imeiInfo/imeiInfoProvider";
import { createSupabasePersistenceOrNull } from "../src/infrastructure/persistence/supabase/supabasePersistence";
import { createSupabaseCacheV2AdaptersOrNull } from "../src/infrastructure/persistence/supabase/cacheV2Adapters";
import { resolveCacheV2Config } from "../src/infrastructure/config/cacheV2Config";
import { createHmacLookupTokenServiceFromEnv } from "../src/infrastructure/security/hmacLookupTokenService";
import { consoleCacheV2ShadowTelemetry } from "../src/infrastructure/telemetry/consoleCacheV2ShadowTelemetry";
import type { CacheV2ShadowDependencies } from "../src/application/cacheV2/shadowWriter";

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
    enrichmentMode: envStr("ENRICHMENT_MODE", "mock"),
    enrichmentFailDecision:
      envStr("ENRICHMENT_FAIL_DECISION", "DECLINE") === "APPROVE" ? "APPROVE" : "DECLINE",
    imeiTimeoutMs: envInt("IMEI_TIMEOUT_MS", 20000),
    imeiPenalty: envInt("SCORE_IMEI_PROBLEM", 5),
    cacheTtlDaysApprove: envInt("CACHE_TTL_DAYS_APPROVE", envInt("CACHE_TTL_DAYS_APROVE", 30)),
    cacheTtlDaysDecline: envInt("CACHE_TTL_DAYS_DECLINE", 30),
    cacheTtlSecondsTechFail: envInt("CACHE_TTL_SECONDS_ON_TECH_FAIL", 300),
  };
}

function composeCacheV2Shadow(traceId: string): CacheV2ShadowDependencies | undefined {
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
    return undefined;
  }
  if (!config.writeEnabled) return undefined;

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

  return {
    analysisReplayRepository: adapters?.analysisReplayRepository ?? null,
    enrichmentEvidenceCache: adapters?.enrichmentEvidenceCache ?? null,
    imeiEvidenceCache: adapters?.imeiEvidenceCache ?? null,
    lookupTokenService,
    telemetry: consoleCacheV2ShadowTelemetry,
    techTrailTtlDays: config.techTrailTtlDays,
    imeiTtlDays: config.imeiTtlDays,
    replayTtlDays: config.replayTtlDays,
    versions: {
      cacheSchemaVersion: "cache-v2-schema-v1",
      techTrailProviderContractVersion: "techtrail-person-v1",
      techTrailNormalizerVersion: "techtrail-normalizer-v1",
      imeiProviderContractVersion: "imei-info-v1",
      imeiNormalizerVersion: "imei-normalizer-v1",
    },
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

    const useCase = new AnalyzeAntifraudUseCase({
      enrichmentProvider: techTrailEnrichmentProvider,
      imeiProvider: imeiInfoProvider,
      decisionCache: persistence?.decisionCache ?? null,
      decisionAuditRepository: persistence?.decisionAuditRepository ?? null,
      providerRawRepository: persistence?.providerRawRepository ?? null,
      cacheV2Shadow: composeCacheV2Shadow(traceId),
    });
    const result = await useCase.execute({
      body: req.body,
      traceId,
      startedAtMs,
      config: resolveConfig(),
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
