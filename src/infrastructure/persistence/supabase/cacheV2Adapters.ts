import { createClient } from "@supabase/supabase-js";
import type {
  AnalysisReplayEntry,
  AnalysisReplayKey,
  AnalysisReplayRepository,
  CacheLookup,
  EnrichmentEvidence,
  EnrichmentEvidenceCache,
  EnrichmentEvidenceKey,
  ImeiEvidence,
  ImeiEvidenceCache,
  ImeiEvidenceKey,
} from "../../../application/ports";

type SupabaseLike = { from(table: string): any };

export type SupabaseCacheV2Adapters = {
  analysisReplayRepository: AnalysisReplayRepository;
  enrichmentEvidenceCache: EnrichmentEvidenceCache;
  imeiEvidenceCache: ImeiEvidenceCache;
};

function errorCode(error: any) {
  return String(error?.code ?? "CACHE_BACKEND_ERROR");
}

function expired(expiresAt: string) {
  return Date.parse(expiresAt) <= Date.now();
}

function ageMs(timestamp: string) {
  return Math.max(0, Date.now() - Date.parse(timestamp));
}

function latest(query: any) {
  return query.order("fetched_at", { ascending: false }).limit(1).maybeSingle();
}

function incompatible(actual: any, expected: {
  providerContractVersion: string;
  normalizerVersion: string;
  cacheSchemaVersion: string;
}): string | null {
  if (actual.provider_contract_version !== expected.providerContractVersion) return "PROVIDER_CONTRACT_VERSION";
  if (actual.normalizer_version !== expected.normalizerVersion) return "NORMALIZER_VERSION";
  if (actual.cache_schema_version !== expected.cacheSchemaVersion) return "CACHE_SCHEMA_VERSION";
  return null;
}

export function createSupabaseCacheV2Adapters(client: SupabaseLike): SupabaseCacheV2Adapters {
  const analysisReplayRepository: AnalysisReplayRepository = {
    async get(key: AnalysisReplayKey): Promise<CacheLookup<AnalysisReplayEntry>> {
      try {
        const { data, error } = await client
          .from("analysis_replay")
          .select("proposal_id, input_hash, rule_version, cache_schema_version, result_json, created_at, expires_at")
          .eq("proposal_id", key.proposalId ?? "")
          .eq("input_hash", key.inputHash)
          // The existing rule_version column is the internal policy namespace
          // for replay. The public response ruleVersion remains independent.
          .eq("rule_version", key.analysisPolicyVersion)
          .eq("cache_schema_version", key.cacheSchemaVersion)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) return { state: "BACKEND_ERROR", errorCode: errorCode(error) };
        if (!data) return { state: "MISS" };
        if (data.rule_version !== key.analysisPolicyVersion) return { state: "INCOMPATIBLE", reason: "ANALYSIS_POLICY_VERSION" };
        if (data.cache_schema_version !== key.cacheSchemaVersion) return { state: "INCOMPATIBLE", reason: "CACHE_SCHEMA_VERSION" };
        if (expired(data.expires_at)) return { state: "EXPIRED", expiredAt: data.expires_at };
        return {
          state: "HIT",
          ageMs: ageMs(data.created_at),
          value: {
            proposalId: data.proposal_id || null,
            inputHash: data.input_hash,
            analysisPolicyVersion: data.rule_version,
            cacheSchemaVersion: data.cache_schema_version,
            result: data.result_json,
            createdAt: data.created_at,
            expiresAt: data.expires_at,
          },
        };
      } catch (error) {
        return { state: "BACKEND_ERROR", errorCode: errorCode(error) };
      }
    },
    async put(entry) {
      const { error } = await client.from("analysis_replay").upsert({
        proposal_id: entry.proposalId ?? "",
        input_hash: entry.inputHash,
        rule_version: entry.analysisPolicyVersion,
        cache_schema_version: entry.cacheSchemaVersion,
        result_json: entry.result,
        created_at: entry.createdAt,
        expires_at: entry.expiresAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: "proposal_id,input_hash,rule_version,cache_schema_version" });
      if (error) throw error;
    },
  };

  const enrichmentEvidenceCache: EnrichmentEvidenceCache = {
    async get(key: EnrichmentEvidenceKey): Promise<CacheLookup<EnrichmentEvidence>> {
      try {
        const { data, error } = await latest(client
          .from("techtrail_evidence_cache")
          .select("lookup_token, provider, normalized_evidence, fetched_at, expires_at, provider_contract_version, normalizer_version, cache_schema_version, completeness, raw_reference")
          .eq("lookup_token", key.lookupToken)
          .eq("provider", key.provider));
        if (error) return { state: "BACKEND_ERROR", errorCode: errorCode(error) };
        if (!data) return { state: "MISS" };
        const reason = incompatible(data, key);
        if (reason) return { state: "INCOMPATIBLE", reason };
        if (expired(data.expires_at)) return { state: "EXPIRED", expiredAt: data.expires_at };
        return {
          state: "HIT",
          ageMs: ageMs(data.fetched_at),
          value: {
            lookupToken: data.lookup_token,
            provider: data.provider,
            normalizedEvidence: data.normalized_evidence,
            fetchedAt: data.fetched_at,
            expiresAt: data.expires_at,
            providerContractVersion: data.provider_contract_version,
            normalizerVersion: data.normalizer_version,
            cacheSchemaVersion: data.cache_schema_version,
            completeness: data.completeness,
            rawReference: data.raw_reference,
          },
        };
      } catch (error) {
        return { state: "BACKEND_ERROR", errorCode: errorCode(error) };
      }
    },
    async put(evidence) {
      const { error } = await client.from("techtrail_evidence_cache").upsert({
        lookup_token: evidence.lookupToken,
        provider: evidence.provider,
        normalized_evidence: evidence.normalizedEvidence,
        fetched_at: evidence.fetchedAt,
        expires_at: evidence.expiresAt,
        provider_contract_version: evidence.providerContractVersion,
        normalizer_version: evidence.normalizerVersion,
        cache_schema_version: evidence.cacheSchemaVersion,
        completeness: evidence.completeness,
        raw_reference: evidence.rawReference ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "lookup_token,provider,provider_contract_version,normalizer_version,cache_schema_version" });
      if (error) throw error;
    },
  };

  const imeiEvidenceCache: ImeiEvidenceCache = {
    async get(key: ImeiEvidenceKey): Promise<CacheLookup<ImeiEvidence>> {
      try {
        const { data, error } = await latest(client
          .from("imei_evidence_cache")
          .select("lookup_token, provider, service, normalized_evidence, fetched_at, expires_at, provider_contract_version, normalizer_version, cache_schema_version, completeness, raw_reference")
          .eq("lookup_token", key.lookupToken)
          .eq("provider", key.provider)
          .eq("service", key.service));
        if (error) return { state: "BACKEND_ERROR", errorCode: errorCode(error) };
        if (!data) return { state: "MISS" };
        const reason = incompatible(data, key);
        if (reason) return { state: "INCOMPATIBLE", reason };
        if (expired(data.expires_at)) return { state: "EXPIRED", expiredAt: data.expires_at };
        return {
          state: "HIT",
          ageMs: ageMs(data.fetched_at),
          value: {
            lookupToken: data.lookup_token,
            provider: data.provider,
            service: data.service,
            normalizedEvidence: data.normalized_evidence,
            fetchedAt: data.fetched_at,
            expiresAt: data.expires_at,
            providerContractVersion: data.provider_contract_version,
            normalizerVersion: data.normalizer_version,
            cacheSchemaVersion: data.cache_schema_version,
            completeness: data.completeness,
            rawReference: data.raw_reference,
          },
        };
      } catch (error) {
        return { state: "BACKEND_ERROR", errorCode: errorCode(error) };
      }
    },
    async put(evidence) {
      const { error } = await client.from("imei_evidence_cache").upsert({
        lookup_token: evidence.lookupToken,
        provider: evidence.provider,
        service: evidence.service,
        normalized_evidence: evidence.normalizedEvidence,
        fetched_at: evidence.fetchedAt,
        expires_at: evidence.expiresAt,
        provider_contract_version: evidence.providerContractVersion,
        normalizer_version: evidence.normalizerVersion,
        cache_schema_version: evidence.cacheSchemaVersion,
        completeness: evidence.completeness,
        raw_reference: evidence.rawReference ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "lookup_token,provider,service,provider_contract_version,normalizer_version,cache_schema_version" });
      if (error) throw error;
    },
  };

  return { analysisReplayRepository, enrichmentEvidenceCache, imeiEvidenceCache };
}

export function createSupabaseCacheV2AdaptersOrNull(): SupabaseCacheV2Adapters | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createSupabaseCacheV2Adapters(createClient(url, key, { auth: { persistSession: false } }));
}
