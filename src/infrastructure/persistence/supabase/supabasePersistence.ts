import { createClient } from "@supabase/supabase-js";
import type {
  DecisionAudit,
  DecisionAuditRepository,
  DecisionCache,
  DecisionCacheEntry,
  DecisionCacheWrite,
  EnrichmentRaw,
  ImeiRaw,
  ProviderRawRepository,
} from "../../../application/ports";

type SupabaseLike = {
  from(table: string): any;
};

export type SupabasePersistence = {
  decisionCache: DecisionCache;
  decisionAuditRepository: DecisionAuditRepository;
  providerRawRepository: ProviderRawRepository;
};

function nowIso() {
  return new Date().toISOString();
}

function expiresAt(input: DecisionCacheWrite) {
  const date = new Date();
  if (input.ttlKind === "seconds") date.setSeconds(date.getSeconds() + input.ttlValue);
  else date.setDate(date.getDate() + input.ttlValue);
  return date.toISOString();
}

export function createSupabasePersistence(client: SupabaseLike): SupabasePersistence {
  const decisionCache: DecisionCache = {
    async get(cpf): Promise<DecisionCacheEntry | null> {
      try {
        const { data, error } = await client
          .from("decision_cache")
          .select("cpf, decision, score, reasons, rule_version, expires_at")
          .eq("cpf", cpf)
          .gt("expires_at", nowIso())
          .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        return {
          cpf: data.cpf,
          decision: data.decision,
          score: data.score,
          reasons: data.reasons,
          ruleVersion: data.rule_version,
          expiresAt: data.expires_at,
        };
      } catch (err) {
        console.error("[cacheGet] failed", err);
        return null;
      }
    },

    async set(input): Promise<string | null> {
      try {
        const expiration = expiresAt(input);
        const { error } = await client.from("decision_cache").upsert(
          {
            cpf: input.cpf,
            decision: input.decision,
            score: input.score,
            reasons: input.reasons,
            rule_version: input.ruleVersion,
            expires_at: expiration,
            updated_at: input.updatedAtIso,
          },
          { onConflict: "cpf" }
        );
        if (error) throw error;
        return expiration;
      } catch (err) {
        console.error("[cacheUpsert] failed", err);
        return null;
      }
    },
  };

  const decisionAuditRepository: DecisionAuditRepository = {
    async saveDecision(row: DecisionAudit) {
      try {
        const { error } = await client.from("decision_log").insert({
          trace_id: row.traceId,
          cpf: row.cpf,
          source: row.source,
          cache_hit: row.cacheHit,
          decision: row.decision,
          score: row.score,
          reasons: row.reasons,
          rule_version: row.ruleVersion,
          input_summary: row.inputSummary,
          events: row.events,
          latency_ms: row.latencyMs,
          created_at: nowIso(),
        });
        if (error) throw error;
      } catch (err) {
        console.error("[decision_log] insert failed", { trace_id: row.traceId, err });
      }
    },
  };

  const providerRawRepository: ProviderRawRepository = {
    async saveEnrichment(row: EnrichmentRaw) {
      try {
        const { error } = await client.from("enrichment_raw").insert({
          trace_id: row.traceId,
          cpf: row.cpf,
          provider: row.provider,
          ok: row.ok,
          mode: row.mode,
          http_status: row.httpStatus,
          latency_ms: row.latencyMs,
          request_params: row.requestParams,
          response_json: row.responseJson,
          error: row.error,
          created_at: nowIso(),
        });
        if (error) throw error;
      } catch (err) {
        console.error("[enrichment_raw] insert failed", { trace_id: row.traceId, err });
      }
    },

    async saveImei(row: ImeiRaw) {
      try {
        // Compatibilidade: o caminho legado ignora `error` retornado pelo SDK e
        // trata apenas exceptions lançadas pelo insert de imei_raw.
        await client.from("imei_raw").insert({
          trace_id: row.traceId,
          cpf: row.cpf,
          provider: row.result.provider,
          ok: row.result.ok,
          http_status: row.result.httpStatus ?? null,
          latency_ms: row.result.ms ?? null,
          service_id: row.result.serviceId ?? null,
          brand_expected: row.result.brandExpected ?? null,
          brand_returned: row.result.brandReturned ?? null,
          reason: row.result.reason,
          request_params: {
            imeiCode: row.imeiCode,
            modeloDeclarado: row.modeloDeclarado,
          },
          summary_json: row.result.summary ?? null,
          response_json: row.result.raw ?? null,
          created_at: nowIso(),
        });
      } catch (err) {
        console.error("[imei_raw] insert failed", err);
      }
    },

    async saveImeiBlacklist(row) {
      try {
        await client.from("imei_raw").insert({
          trace_id: row.traceId,
          cpf: row.cpf,
          provider: row.result.provider,
          ok: row.result.status === "CLEAN" || row.result.status === "BLACKLISTED" || row.result.status === "UNKNOWN",
          http_status: row.result.httpStatus,
          latency_ms: row.result.latencyMs,
          service_id: row.result.service?.startsWith("blacklist:")
            ? Number(row.result.service.slice("blacklist:".length))
            : null,
          brand_expected: null,
          brand_returned: row.result.manufacturer,
          reason: `IMEI_BLACKLIST_${row.result.status}`,
          request_params: { imeiCode: row.imeiCode, policy: "BLACKLIST_V1" },
          summary_json: {
            model: row.result.model,
            modelName: row.result.modelName,
            manufacturer: row.result.manufacturer,
            blacklistStatusRaw: row.result.blacklistStatusRaw,
            generalListStatus: row.result.generalListStatus,
            blacklistRecords: row.result.blacklistRecords,
            deviceIsClean: row.result.deviceIsClean,
            providerCreatedAt: row.result.providerCreatedAt,
          },
          response_json: row.result.raw ?? null,
          created_at: nowIso(),
        });
      } catch (err) {
        console.error("[imei_raw] blacklist insert failed", err);
      }
    },
  };

  return { decisionCache, decisionAuditRepository, providerRawRepository };
}

export function createSupabasePersistenceOrNull(): SupabasePersistence | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createSupabasePersistence(createClient(url, key, { auth: { persistSession: false } }));
}
