import type {
  DecisionAuditRepository,
  DecisionCache,
  EnrichmentProvider,
  EnrichmentProviderInput,
  ImeiProvider,
  ImeiBlacklistProvider,
  CacheV2ShadowTelemetry,
  CacheV2ShadowEvent,
  ProviderRawRepository,
} from "../ports";
import type { CacheV2ShadowDependencies } from "../cacheV2/shadowWriter";
import {
  evaluateReplayEligibility,
  shadowWriteImei,
  shadowWriteImeiBlacklist,
  shadowWriteReplay,
  shadowWriteTechTrail,
} from "../cacheV2/shadowWriter";
import type { TechTrailReadDependencies } from "../cacheV2/techTrailReader";
import { readTechTrailEvidence } from "../cacheV2/techTrailReader";
import type { ImeiReadDependencies } from "../cacheV2/imeiReader";
import { readImeiEvidence } from "../cacheV2/imeiReader";
import type { ImeiBlacklistReadDependencies } from "../cacheV2/imeiBlacklistReader";
import { readImeiBlacklistEvidence } from "../cacheV2/imeiBlacklistReader";
import type { AnalysisReplayReadDependencies } from "../cacheV2/analysisReplayReader";
import {
  readAnalysisReplay,
  resolveAnalysisPolicyVersion,
} from "../cacheV2/analysisReplayReader";
import { decisionConfigFingerprint } from "../cacheV2/decisionPolicy";
export { buildReplayInput } from "../cacheV2/replayInput";
import type {
  Decision,
  FinalEvaluationResult,
  ImeiBlacklistEvidence,
  ImeiBlacklistStatus,
  InputSummary,
  NormalizedImeiResult,
  ScoreBreakdownItem,
} from "../../domain/contracts";
import {
  classifyProfileByScore,
  finalizeBlacklistEvaluation,
  finalizeEvaluation,
  isConsistentImeiBlacklistFactualStatus,
  preEvaluate,
  resolveDecisionScoreConfig,
  type DecisionScoreConfig,
} from "../../domain/engine";

export type AnalyzeAntifraudDependencies = {
  enrichmentProvider: EnrichmentProvider;
  imeiProvider: ImeiProvider;
  imeiBlacklistProvider?: ImeiBlacklistProvider;
  decisionCache: DecisionCache | null;
  decisionAuditRepository: DecisionAuditRepository | null;
  providerRawRepository: ProviderRawRepository | null;
  cacheV2Shadow?: CacheV2ShadowDependencies;
  cacheV2TechTrailRead?: TechTrailReadDependencies;
  cacheV2ImeiRead?: ImeiReadDependencies;
  cacheV2ImeiBlacklistRead?: ImeiBlacklistReadDependencies;
  cacheV2ReplayRead?: AnalysisReplayReadDependencies;
  imeiBlacklistTelemetry?: CacheV2ShadowTelemetry;
};

export type AnalyzeAntifraudConfig = {
  supabaseMissingPolicy: string;
  enrichmentTimeoutMs: number;
  enrichmentMode: "off" | "mock" | "real";
  enrichmentFailDecision: Decision;
  imeiTimeoutMs: number;
  imeiPenalty: number;
  cacheTtlDaysApprove: number;
  cacheTtlDaysDecline: number;
  cacheTtlSecondsTechFail: number;
  decisionCacheV1ReadEnabled?: boolean;
  imeiBlacklistV1Enabled?: boolean;
  decisionScoreConfig?: DecisionScoreConfig;
};

export type AnalyzeAntifraudCommand = {
  body: any;
  traceId: string;
  startedAtMs: number;
  config: AnalyzeAntifraudConfig;
};

export type AnalyzeAntifraudResult = {
  statusCode: number;
  body: any;
};

function nowIso() {
  return new Date().toISOString();
}

function unavailableBlacklistEvidence(imei: string, service: string | null, reason: string): ImeiBlacklistEvidence {
  return {
    imei, provider: "imei_info", service, status: "UNAVAILABLE",
    model: null, modelName: null, manufacturer: null, blacklistStatusRaw: null,
    generalListStatus: null, blacklistRecords: null, deviceIsClean: null,
    providerCreatedAt: null, fetchedAt: nowIso(), rawReference: null,
    httpStatus: null, latencyMs: 0, technicalReason: reason, raw: null,
  };
}

function validBlacklistProviderEvidence(
  result: ImeiBlacklistEvidence,
  expectedImei: string,
  expectedService: string
) {
  const fetchedAt = result ? Date.parse(result.fetchedAt) : Number.NaN;
  if (!result || result.imei !== expectedImei || result.provider !== "imei_info" ||
      result.service !== expectedService || !Number.isFinite(fetchedAt) || fetchedAt > Date.now()) return false;
  if (result.status === "UNAVAILABLE" || result.status === "INVALID") return true;
  return isConsistentImeiBlacklistFactualStatus(result.status, {
    model: result.model,
    modelName: result.modelName,
    manufacturer: result.manufacturer,
    blacklistStatusRaw: result.blacklistStatusRaw,
    generalListStatus: result.generalListStatus,
    blacklistRecords: result.blacklistRecords,
    deviceIsClean: result.deviceIsClean,
    providerCreatedAt: result.providerCreatedAt,
    imeiNumber: null,
  });
}

function onlyDigits(value: string) {
  return (value || "").replace(/\D/g, "");
}

function normalizeEmail(value: any) {
  return value ? String(value).trim().toLowerCase() : null;
}

function normalizeCep(value: any) {
  const digits = onlyDigits(String(value ?? ""));
  if (!digits) return null;
  return digits.length > 8 ? digits.slice(0, 8) : digits;
}

function normalizePhone(value: any) {
  const digits = onlyDigits(String(value ?? ""));
  return digits || null;
}

function toNumberOrNull(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function buildInputSummary(body: any): InputSummary {
  return {
    cpf: body?.cpf ? onlyDigits(String(body.cpf)) : null,
    nome: body?.nome ? String(body.nome).trim() : null,
    email: body?.email ? String(body.email).trim().toLowerCase() : null,
    telefone_contato: body?.telefone_contato ? onlyDigits(String(body.telefone_contato)) : null,
    valor_celular:
      body?.valor_celular === null || body?.valor_celular === undefined || body?.valor_celular === ""
        ? null
        : Number(body.valor_celular),
    cep: body?.cep ? onlyDigits(String(body.cep)) : null,
    imeiCode: body?.imeiCode ? String(body.imeiCode).trim() : null,
    modelo_declarado: body?.modelo_declarado ? String(body.modelo_declarado).trim() : null,
    partnerCode: body?.partnerCode ? String(body.partnerCode) : null,
    salesChannel: body?.salesChannel ? String(body.salesChannel) : null,
    proposalId: body?.proposalId ? String(body.proposalId) : null,
    sessionId: body?.sessionId ? String(body.sessionId) : null,
    device: body?.device ?? null,
  };
}

function buildPublicImeiSummary(summary: any) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return summary ?? null;
  }
  const publicSummary = { ...summary };
  delete publicSummary.imei_checked;
  return publicSummary;
}

function normalizeEnrichmentInput(body: any, traceId: string): EnrichmentProviderInput {
  return {
    traceId: String(traceId),
    cpf: String(body?.cpf ?? "").replace(/\D/g, ""),
    nome: body?.nome ? String(body.nome).trim() : null,
    email: normalizeEmail(body?.email),
    telefone_contato: normalizePhone(body?.telefone_contato),
    valor_celular: toNumberOrNull(body?.valor_celular),
    cep: normalizeCep(body?.cep),
    partnerCode: body?.partnerCode ? String(body.partnerCode) : null,
    salesChannel: body?.salesChannel ? String(body.salesChannel) : null,
    proposalId: body?.proposalId ? String(body.proposalId) : null,
    sessionId: body?.sessionId ? String(body.sessionId) : null,
  };
}

export class AnalyzeAntifraudUseCase {
  constructor(private readonly dependencies: AnalyzeAntifraudDependencies) {}

  async execute(command: AnalyzeAntifraudCommand): Promise<AnalyzeAntifraudResult> {
    const { body, traceId, startedAtMs: started, config } = command;
    const {
      enrichmentProvider,
      imeiProvider,
      imeiBlacklistProvider,
      decisionCache,
      decisionAuditRepository,
      providerRawRepository,
      cacheV2Shadow,
      cacheV2TechTrailRead,
      cacheV2ImeiRead,
      cacheV2ImeiBlacklistRead,
      cacheV2ReplayRead,
      imeiBlacklistTelemetry,
    } = this.dependencies;
    const hasPersistence = !!decisionCache && !!decisionAuditRepository && !!providerRawRepository;
    const events: any[] = [];
    const auditOnlyEvents: any[] = [];
    const eventsForAudit = () => auditOnlyEvents.length ? [...events, ...auditOnlyEvents] : events;
    let techTrailShadowCandidate: { cpf: string; result: any; fetchedAt: string } | null = null;
    let imeiShadowCandidate: {
      imeiCode: string;
      result: NormalizedImeiResult;
      fetchedAt: string;
    } | null = null;
    let imeiBlacklistShadowCandidate: ImeiBlacklistEvidence | null = null;
    const mark = (step: string, ok: boolean, meta?: any) => {
      events.push({ ts: nowIso(), ms: Date.now() - started, step, ok, meta: meta ?? undefined });
    };
    const recordBlacklist = (name: CacheV2ShadowEvent["name"], ok: boolean, meta?: any, emitTelemetry = true) => {
      auditOnlyEvents.push({ ts: nowIso(), ms: Date.now() - started, step: name, ok, meta: meta ?? undefined });
      try { if (emitTelemetry) imeiBlacklistTelemetry?.record({ name, traceId, reason: meta?.reason, details: meta }); }
      catch { console.error("[imei-blacklist] telemetry failed"); }
    };

    mark("request_received", true);

    const inputSummary = buildInputSummary(body);
    const cpf = inputSummary.cpf;
    const fingerprintSnapshot = inputSummary.device
      ? {
          ip: inputSummary.device.ip ?? null,
          visitorId: inputSummary.device.visitorId ?? null,
          os: inputSummary.device.os ?? null,
          gpu: inputSummary.device.gpu ?? null,
          cores: inputSummary.device.cores ?? null,
          isMobile: inputSummary.device.isMobile ?? null,
          osVersion: inputSummary.device.osVersion ?? null,
          browserName: inputSummary.device.browserName ?? null,
          screenWidthPhysical: inputSummary.device.screenWidthPhysical ?? null,
          screenHeightPhysical: inputSummary.device.screenHeightPhysical ?? null,
          fingerprintProvider: inputSummary.device.fingerprintProvider ?? null,
        }
      : null;

    mark("fingerprint_snapshot", true, { hasFingerprint: !!fingerprintSnapshot });
    mark("input_summary_built", true, {
      hasImeiCode: !!inputSummary.imeiCode,
    });

    if (!cpf) {
      mark("validate_input", false, { reason: "missing_cpf" });
      return { statusCode: 400, body: { ok: false, traceId, error: "Missing cpf" } };
    }
    mark("validate_input", true);

    const decisionScoreConfig = config.decisionScoreConfig ?? resolveDecisionScoreConfig();
    const configFingerprint = decisionConfigFingerprint({
      scoring: decisionScoreConfig,
      imeiProblemScore: config.imeiPenalty,
      enrichmentMode: config.enrichmentMode,
      enrichmentFailDecision: config.enrichmentFailDecision,
      enrichmentTimeoutMs: config.enrichmentTimeoutMs,
      imeiTimeoutMs: config.imeiTimeoutMs,
    });
    const analysisPolicyVersion = resolveAnalysisPolicyVersion(
      config.imeiBlacklistV1Enabled === true,
      configFingerprint
    );
    if (cacheV2ReplayRead) {
      const replay = await readAnalysisReplay(cacheV2ReplayRead, {
        traceId,
        inputSummary,
        analysisPolicyVersion,
      });
      if (replay.state === "HIT") {
        return {
          statusCode: replay.result.statusCode,
          body: replay.result.body,
        };
      }
    }

    if (!hasPersistence) {
      const details = "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY";
      console.error("[analyze] supabase missing", details);
      if (config.supabaseMissingPolicy === "fail") {
        return {
          statusCode: 500,
          body: { ok: false, traceId, error: "FUNCTION_INVOCATION_FAILED", details },
        };
      }
      mark("supabase_missing_continue", true);
    }

    let hit = null;
    let cacheGetMs = 0;
    if (hasPersistence && config.decisionCacheV1ReadEnabled !== false && config.imeiBlacklistV1Enabled !== true) {
      const cacheGetStarted = Date.now();
      try {
        hit = await decisionCache.get(cpf);
      } catch {
        console.error("[cacheGet] failed", { traceId, reason: "BACKEND_ERROR" });
      }
      cacheGetMs = Date.now() - cacheGetStarted;
      mark("cache_get", true, { hit: !!hit, cacheGetMs });
    } else if (config.imeiBlacklistV1Enabled === true && hasPersistence) {
      auditOnlyEvents.push({
        ts: nowIso(), ms: Date.now() - started,
        step: "cache_get_skipped_blacklist_policy", ok: true,
      });
    } else {
      mark("cache_get_skipped_no_supabase", true);
    }

    if (hit) {
      const totalMs = Date.now() - started;
      mark("response_sent", true, { source: "cache" });
      const responseBody = {
        ok: true,
        traceId,
        source: "cache",
        cpf,
        decision: hit.decision,
        score: hit.score,
        reasons: hit.reasons,
        ruleVersion: hit.ruleVersion,
        timingsMs: { cacheGetMs, totalMs },
        events,
        fingerprint: fingerprintSnapshot,
      };
      if (hasPersistence) {
        try {
          await decisionAuditRepository.saveDecision({
            traceId, cpf, source: "cache", cacheHit: true, decision: hit.decision,
            score: hit.score, reasons: hit.reasons, ruleVersion: hit.ruleVersion,
            inputSummary, events: eventsForAudit(), latencyMs: totalMs,
          });
        } catch {
          console.error("[decision_log] insert failed", { trace_id: traceId, reason: "BACKEND_ERROR" });
        }
      }
      if (cacheV2Shadow) {
        await shadowWriteReplay(cacheV2Shadow, {
          traceId,
          inputSummary,
          analysisPolicyVersion,
          statusCode: 200,
          responseBody,
          createdAt: nowIso(),
          eligibility: evaluateReplayEligibility({ cachedReasons: hit.reasons }),
        });
      }
      return { statusCode: 200, body: responseBody };
    }

    const providerInput = normalizeEnrichmentInput(body, traceId);
    const enrichStarted = Date.now();
    let enrichResult: any = null;
    let enrichTimedOut = false;
    let enrichmentFromV2 = false;
    mark("enrichment_start", true, {
      mode: config.enrichmentMode,
      timeoutMs: config.enrichmentTimeoutMs,
    });
    if (cacheV2TechTrailRead) {
      const cached = await readTechTrailEvidence(cacheV2TechTrailRead, { traceId, cpf });
      if (cached.state === "HIT") {
        enrichmentFromV2 = true;
        enrichResult = {
          ok: true,
          mode: config.enrichmentMode,
          provider: cached.evidence.provider,
          ms: 0,
          httpStatus: null,
          requestParams: null,
          raw: null,
          summary: cached.evidence.normalizedEvidence,
        };
        auditOnlyEvents.push({
          ts: nowIso(),
          ms: Date.now() - started,
          step: "cache_v2_techtrail_read",
          ok: true,
          meta: {
            state: "HIT",
            source: "techtrail_evidence_cache",
            fetchedAt: cached.evidence.fetchedAt,
            expiresAt: cached.evidence.expiresAt,
            rawReference: cached.evidence.rawReference ?? null,
          },
        });
      } else {
        auditOnlyEvents.push({
          ts: nowIso(),
          ms: Date.now() - started,
          step: "cache_v2_techtrail_read",
          ok: cached.cacheState !== "BACKEND_ERROR",
          meta: { state: cached.cacheState, source: "techtrail_evidence_cache" },
        });
      }
    }
    if (!enrichmentFromV2) {
      try {
        enrichResult = await Promise.race([
          enrichmentProvider.enrich(providerInput),
          new Promise((_, reject) => setTimeout(() => {
            enrichTimedOut = true;
            reject(new Error("ENRICHMENT_TIMEOUT"));
          }, config.enrichmentTimeoutMs)),
        ]);
      } catch (err: any) {
        enrichResult = {
          ok: false,
          mode: config.enrichmentMode,
          provider: config.enrichmentMode === "real" ? "techtrail" : "mock",
          ms: Date.now() - enrichStarted,
          httpStatus: null,
          requestParams: providerInput ? { cpf: providerInput.cpf } : { cpf },
          raw: null,
          summary: null,
          error: { msg: err?.message ?? "ENRICHMENT_ERROR" },
        };
      }
    }
    const enrichMs = Date.now() - enrichStarted;
    mark("enrichment_done", !!enrichResult?.ok, {
      mode: config.enrichmentMode,
      enrichMs,
      timedOut: enrichTimedOut,
      provider: enrichResult?.provider,
      httpStatus: enrichResult?.httpStatus ?? null,
    });

    if (hasPersistence && !enrichmentFromV2) {
      try {
        await providerRawRepository.saveEnrichment({
          traceId, cpf,
          provider: enrichResult?.provider ?? "unknown",
          ok: !!enrichResult?.ok,
          mode: enrichResult?.mode ?? config.enrichmentMode,
          httpStatus: enrichResult?.httpStatus ?? null,
          latencyMs: enrichResult?.ms ?? enrichMs,
          requestParams: enrichResult?.requestParams ?? null,
          responseJson: enrichResult?.raw ?? null,
          error: enrichResult?.ok ? null : enrichResult?.error ?? { msg: "ENRICHMENT_FAILED" },
        });
      } catch {
        console.error("[enrichment_raw] insert failed", { trace_id: traceId, reason: "BACKEND_ERROR" });
      }
      mark("enrichment_raw_saved", true);
    } else if (!enrichmentFromV2) {
      mark("enrichment_raw_skipped_no_supabase", true);
    } else {
      // Preserva a sequência pública legada; a auditoria interna identifica
      // que nenhum enrichment_raw novo foi criado para o HIT V2.
      mark("enrichment_raw_saved", true);
    }
    if (!enrichmentFromV2) {
      techTrailShadowCandidate = {
        cpf,
        result: enrichResult,
        fetchedAt: new Date(enrichStarted).toISOString(),
      };
    }

    let decision: Decision;
    let reasons: string[] = [];
    let score: number | null = null;
    let scoreBreakdown: ScoreBreakdownItem[] = [];
    const ruleVersion = config.imeiBlacklistV1Enabled === true
      ? "score-v1+imei-blacklist-v1"
      : "score-v1";
    let isTechFail = false;
    let isHardBlock = false;
    let imeiResultGlobal: NormalizedImeiResult | null = null;
    let imeiBlacklistResultGlobal: ImeiBlacklistEvidence | null = null;

    if (enrichResult?.ok && enrichResult?.summary) {
      const preEvaluation = preEvaluate(enrichResult, inputSummary, decisionScoreConfig);
      isHardBlock = preEvaluation.hardBlock.isHardBlock;
      mark("hard_block_check", true, {
        isHardBlock,
        reasons: preEvaluation.hardBlock.reasons,
      });
      if (isHardBlock) {
        if (config.imeiBlacklistV1Enabled === true) {
          recordBlacklist("IMEI_BLACKLIST_SKIPPED_HARD_BLOCK", true, { reason: "HARD_BLOCK" });
        }
        const evaluation = finalizeEvaluation(preEvaluation, null, 0);
        decision = evaluation.decision;
        reasons = evaluation.reasons;
        score = evaluation.score;
        scoreBreakdown = evaluation.scoreBreakdown;
      } else {
        score = preEvaluation.baseScore;
        scoreBreakdown = preEvaluation.scoreBreakdown;
        const flags = preEvaluation.telemetryFlags!;
        const scoreComputedMeta = { score, breakdown: scoreBreakdown, flags };
        mark("score_computed", true, scoreComputedMeta);
        let imeiResult: NormalizedImeiResult | null = null;
        let blacklistResult: ImeiBlacklistEvidence | null = null;
        let evaluation: FinalEvaluationResult;
        if (config.imeiBlacklistV1Enabled === true) {
          const baseProfile = classifyProfileByScore(preEvaluation.baseScore ?? 0);
          if (baseProfile === "A" || baseProfile === "C") {
            const eventName = baseProfile === "A"
              ? "IMEI_BLACKLIST_SKIPPED_PROFILE_A"
              : "IMEI_BLACKLIST_SKIPPED_PROFILE_C";
            recordBlacklist(eventName, true, { profile: baseProfile });
            mark("imei_check_skipped", true, { reason: `profile_${baseProfile.toLowerCase()}` });
          } else if (!inputSummary.imeiCode) {
            recordBlacklist("IMEI_BLACKLIST_SKIPPED_NO_IMEI", true, { profile: baseProfile });
            mark("imei_check_skipped", true, { reason: "missing_imei" });
          } else if (!imeiBlacklistProvider) {
            blacklistResult = unavailableBlacklistEvidence(inputSummary.imeiCode, null, "PROVIDER_UNAVAILABLE");
          } else {
            const validation = imeiBlacklistProvider.normalizeAndValidate(inputSummary.imeiCode);
            if (!validation.valid) {
              blacklistResult = {
                ...unavailableBlacklistEvidence(validation.normalizedImei, imeiBlacklistProvider.service, "LOCAL_VALIDATION_FAILED"),
                status: "INVALID",
                technicalReason: null,
              };
            } else if (!imeiBlacklistProvider.service) {
              blacklistResult = unavailableBlacklistEvidence(validation.normalizedImei, null, "MISSING_BLACKLIST_SERVICE_ID");
            } else {
              mark("imei_check_start", true, { hasImei: true, policy: "BLACKLIST_V1" });
              let fromCache = false;
              if (cacheV2ImeiBlacklistRead) {
                const cached = await readImeiBlacklistEvidence(cacheV2ImeiBlacklistRead, {
                  traceId,
                  imeiCode: validation.normalizedImei,
                });
                if (cached.state === "HIT") {
                  fromCache = true;
                  blacklistResult = cached.result;
                  recordBlacklist("IMEI_BLACKLIST_CACHE_HIT", true, {
                    state: "HIT", source: "imei_evidence_cache",
                    fetchedAt: cached.evidence.fetchedAt, expiresAt: cached.evidence.expiresAt,
                    rawReference: cached.evidence.rawReference ?? null,
                    ageMs: Math.max(0, Date.now() - Date.parse(cached.evidence.fetchedAt)),
                    provider: cached.evidence.provider, service: cached.evidence.service,
                  }, false);
                } else {
                  recordBlacklist("IMEI_BLACKLIST_CACHE_MISS", cached.cacheState !== "BACKEND_ERROR", {
                    state: cached.cacheState, source: "imei_evidence_cache",
                  }, false);
                }
              }
              if (!fromCache) {
                try {
                  blacklistResult = await imeiBlacklistProvider.check({
                    imeiCode: validation.normalizedImei,
                    timeoutMs: config.imeiTimeoutMs,
                  });
                  if (!validBlacklistProviderEvidence(
                    blacklistResult,
                    validation.normalizedImei,
                    imeiBlacklistProvider.service
                  )) {
                    const rejectedResult = blacklistResult;
                    blacklistResult = {
                      ...unavailableBlacklistEvidence(
                        validation.normalizedImei,
                        imeiBlacklistProvider.service,
                        "INVALID_PROVIDER_RESULT"
                      ),
                      raw: rejectedResult?.raw ?? rejectedResult,
                    };
                  }
                } catch (error: any) {
                  blacklistResult = unavailableBlacklistEvidence(
                    validation.normalizedImei,
                    imeiBlacklistProvider.service,
                    error?.message ?? "PROVIDER_EXCEPTION"
                  );
                }
                const currentBlacklistResult = blacklistResult as ImeiBlacklistEvidence;
                if (hasPersistence && providerRawRepository.saveImeiBlacklist) {
                  try {
                    await providerRawRepository.saveImeiBlacklist({
                      traceId, cpf, imeiCode: validation.normalizedImei, result: currentBlacklistResult,
                    });
                  } catch {
                    console.error("[imei_raw] blacklist insert failed", { traceId, reason: "BACKEND_ERROR" });
                  }
                }
                if (currentBlacklistResult.status === "CLEAN" || currentBlacklistResult.status === "BLACKLISTED" || currentBlacklistResult.status === "UNKNOWN") {
                  imeiBlacklistShadowCandidate = currentBlacklistResult;
                }
              }
              const completedBlacklistResult = blacklistResult as ImeiBlacklistEvidence;
              mark("imei_check_done", completedBlacklistResult.status !== "UNAVAILABLE", {
                policy: "BLACKLIST_V1", status: completedBlacklistResult.status,
                provider: completedBlacklistResult.provider, service: completedBlacklistResult.service,
                ms: completedBlacklistResult.latencyMs,
              });
            }
          }

          if (blacklistResult) {
            imeiBlacklistResultGlobal = blacklistResult;
            if (blacklistResult.status === "INVALID") {
              imeiResultGlobal = {
                ok: false, provider: "imei_info", ms: 0, reason: "IMEI_INVALID",
                brandExpected: "UNKNOWN", brandReturned: null, serviceId: null,
                summary: null, raw: null,
              };
            }
            const eventsByStatus: Record<ImeiBlacklistStatus, CacheV2ShadowEvent["name"]> = {
              CLEAN: "IMEI_BLACKLIST_CLEAN",
              BLACKLISTED: "IMEI_BLACKLISTED",
              UNKNOWN: "IMEI_BLACKLIST_UNKNOWN",
              UNAVAILABLE: "IMEI_BLACKLIST_UNAVAILABLE",
              INVALID: "IMEI_BLACKLIST_INVALID",
            };
            recordBlacklist(eventsByStatus[blacklistResult.status], blacklistResult.status !== "UNAVAILABLE", {
              status: blacklistResult.status,
              provider: blacklistResult.provider,
              service: blacklistResult.service,
              reason: blacklistResult.technicalReason ?? undefined,
            });
          }
          evaluation = finalizeBlacklistEvaluation(preEvaluation, blacklistResult?.status ?? null, config.imeiPenalty);
        } else {
        if (inputSummary.imeiCode) {
          mark("imei_check_start", true, {
            hasImei: true,
            modeloDeclarado: inputSummary.modelo_declarado ?? null,
          });
          const imeiStartedAt = nowIso();
          let imeiFromV2 = false;
          if (cacheV2ImeiRead) {
            const cached = await readImeiEvidence(cacheV2ImeiRead, {
              traceId,
              imeiCode: inputSummary.imeiCode,
              modeloDeclarado: inputSummary.modelo_declarado,
            });
            if (cached.state === "HIT") {
              imeiFromV2 = true;
              imeiResult = cached.result;
              auditOnlyEvents.push({
                ts: nowIso(), ms: Date.now() - started, step: "cache_v2_imei_read", ok: true,
                meta: {
                  state: "HIT", source: "imei_evidence_cache",
                  fetchedAt: cached.evidence.fetchedAt, expiresAt: cached.evidence.expiresAt,
                  rawReference: cached.evidence.rawReference ?? null,
                  provider: cached.evidence.provider, service: cached.evidence.service,
                  ageMs: Math.max(0, Date.now() - Date.parse(cached.evidence.fetchedAt)),
                },
              });
            } else {
              auditOnlyEvents.push({
                ts: nowIso(), ms: Date.now() - started, step: "cache_v2_imei_read",
                ok: cached.cacheState !== "BACKEND_ERROR",
                meta: { state: cached.cacheState, source: "imei_evidence_cache" },
              });
            }
          }
          if (!imeiFromV2) {
            imeiResult = await imeiProvider.check({
              imeiCode: inputSummary.imeiCode,
              modeloDeclarado: inputSummary.modelo_declarado,
              timeoutMs: config.imeiTimeoutMs,
            });
          }
          const currentImeiResult = imeiResult as NormalizedImeiResult;
          imeiResultGlobal = currentImeiResult;
          if (hasPersistence && !imeiFromV2) {
            try {
              await providerRawRepository.saveImei({
                traceId, cpf,
                imeiCode: inputSummary.imeiCode ?? null,
                modeloDeclarado: inputSummary.modelo_declarado ?? null,
                result: currentImeiResult,
              });
            } catch {
              console.error("[imei_raw] insert failed", { traceId, reason: "BACKEND_ERROR" });
            }
          }
          if (!imeiFromV2) {
            imeiShadowCandidate = {
              imeiCode: inputSummary.imeiCode,
              result: currentImeiResult,
              fetchedAt: imeiStartedAt,
            };
          }
          mark("imei_check_done", currentImeiResult.ok, {
            reason: currentImeiResult.reason,
            provider: currentImeiResult.provider,
            ms: currentImeiResult.ms,
            brandExpected: currentImeiResult.brandExpected ?? null,
            brandReturned: currentImeiResult.brandReturned ?? null,
            serviceId: currentImeiResult.serviceId ?? null,
            imeiSummary: buildPublicImeiSummary(currentImeiResult.summary),
          });
        } else {
          mark("imei_check_skipped", true, { reason: "missing_imei" });
        }
        evaluation = finalizeEvaluation(preEvaluation, imeiResult, config.imeiPenalty);
        }
        decision = evaluation.decision;
        reasons = evaluation.reasons;
        score = evaluation.score;
        scoreBreakdown = evaluation.scoreBreakdown;
        scoreComputedMeta.breakdown = scoreBreakdown;
        mark("decision_profiled", true, {
          profile: evaluation.profile,
          decision,
          score,
          flags,
          imeiReason: config.imeiBlacklistV1Enabled === true
            ? blacklistResult?.status ?? null
            : imeiResult?.reason ?? null,
        });
      }
    } else {
      isTechFail = true;
      decision = config.enrichmentFailDecision;
      reasons = [enrichTimedOut ? "ENRICHMENT_TIMEOUT" : "ENRICHMENT_FAILED"];
      score = null;
      scoreBreakdown = [];
    }

    mark("decision_made", true, { decision, ruleVersion, isTechFail, isHardBlock, score });
    let ttlKind: "days" | "seconds" = "days";
    let ttlValue = 30;
    if (isTechFail) {
      ttlKind = "seconds";
      ttlValue = config.cacheTtlSecondsTechFail;
    } else {
      ttlValue = decision === "APPROVE" ? config.cacheTtlDaysApprove : config.cacheTtlDaysDecline;
    }

    let cacheSetMs = 0;
    if (hasPersistence && config.imeiBlacklistV1Enabled !== true) {
      const cacheSetStarted = Date.now();
      let expiration: string | null = null;
      try {
        expiration = await decisionCache.set({
          cpf, decision, score, reasons, ruleVersion, ttlKind, ttlValue, updatedAtIso: nowIso(),
        });
      } catch {
        console.error("[cacheUpsert] failed", { traceId, reason: "BACKEND_ERROR" });
      }
      cacheSetMs = Date.now() - cacheSetStarted;
      mark("cache_set", !!expiration, {
        ttlKind, ttlValue, expiresAt: expiration ?? null, cacheSetMs,
      });
    } else if (!hasPersistence) {
      mark("cache_set_skipped_no_supabase", true);
    } else {
      auditOnlyEvents.push({
        ts: nowIso(), ms: Date.now() - started,
        step: "cache_set_skipped_blacklist_policy", ok: true,
      });
    }

    const totalMs = Date.now() - started;
    mark("response_sent", true, { source: "engine" });
    const responseBody = {
      ok: true,
      traceId,
      source: "engine",
      cpf,
      decision,
      score,
      reasons,
      ruleVersion,
      timingsMs: { cacheGetMs, enrichMs, cacheSetMs, totalMs },
      scoreBreakdown,
      events,
      fingerprint: fingerprintSnapshot,
      imei: imeiResultGlobal
        ? {
            reason: imeiResultGlobal.reason,
            brandExpected: imeiResultGlobal.brandExpected ?? null,
            brandReturned: imeiResultGlobal.brandReturned ?? null,
            summary: buildPublicImeiSummary(imeiResultGlobal.summary),
          }
        : null,
    };
    if (hasPersistence) {
      try {
        await decisionAuditRepository.saveDecision({
          traceId, cpf, source: "engine", cacheHit: false, decision, score, reasons,
          ruleVersion, inputSummary, events: eventsForAudit(), latencyMs: totalMs,
        });
      } catch {
        console.error("[decision_log] insert failed", { trace_id: traceId, reason: "BACKEND_ERROR" });
      }
    }
    if (cacheV2Shadow) {
      if (techTrailShadowCandidate) {
        await shadowWriteTechTrail(cacheV2Shadow, {
          traceId,
          ...techTrailShadowCandidate,
        });
      }
      if (imeiShadowCandidate) {
        await shadowWriteImei(cacheV2Shadow, {
          traceId,
          ...imeiShadowCandidate,
        });
      }
      if (imeiBlacklistShadowCandidate) {
        await shadowWriteImeiBlacklist(cacheV2Shadow, {
          traceId,
          result: imeiBlacklistShadowCandidate,
        });
      }
      await shadowWriteReplay(cacheV2Shadow, {
        traceId,
        inputSummary,
        analysisPolicyVersion,
        statusCode: 200,
        responseBody,
        createdAt: nowIso(),
        eligibility: evaluateReplayEligibility({
          techTrailTechnicalFailure: isTechFail,
          imeiBlacklistStatus: imeiBlacklistResultGlobal?.status ?? null,
          imeiResult: imeiResultGlobal,
        }),
      });
    }
    return { statusCode: 200, body: responseBody };
  }
}
