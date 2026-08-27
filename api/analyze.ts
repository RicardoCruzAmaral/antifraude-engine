// api/analyze.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import type {
  AnalysisSource,
  Decision,
  InputSummary,
  NormalizedImeiResult,
  ScoreBreakdownItem,
} from "../src/domain/contracts";
import {
  finalizeEvaluation,
  preEvaluate,
} from "../src/domain/engine";
import {
  normalizeEnrichmentInput,
  techTrailEnrichmentProvider,
} from "../src/infrastructure/providers/techtrail/techTrailEnrichmentProvider";
import { imeiInfoProvider } from "../src/infrastructure/providers/imeiInfo/imeiInfoProvider";
import { createSupabasePersistenceOrNull } from "../src/infrastructure/persistence/supabase/supabasePersistence";

type ImeiResult = {
  ok: boolean;
  provider: "mock" | "imei_provider";
  ms: number;
  httpStatus?: number | null;
  timedOut?: boolean;
  reason?: string; // "IMEI_OK" / "IMEI_FAIL" / "IMEI_TIMEOUT"
};

// ===== Utils =====
function nowIso() {
  return new Date().toISOString();
}
function onlyDigits(s: string) {
  return (s || "").replace(/\D/g, "");
}
function envInt(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function envStr(name: string, fallback: string) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}
function normEnum(s: any): string {
  if (!s) return "";
  return String(s)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, ""); // remove acentos: "ALTÍSSIMO" -> "ALTISSIMO"
}
// ===== Input summary =====
function buildInputSummary(body: any): InputSummary {
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

// Provider decision ("ACEITO"/"DECLINADO") -> engine ("APPROVE"/"DECLINE")
function mapProviderDecision(providerDecision: any): Decision {
  const v = normEnum(providerDecision);
  if (v === "ACEITO") return "APPROVE";
  if (v === "DECLINADO") return "DECLINE";
  return envStr("ENRICHMENT_FAIL_DECISION", "DECLINE") === "APPROVE" ? "APPROVE" : "DECLINE";
}

function checkHardBlocks(summary: any) {
  const motivos = summary?.motivos ?? [];

  const HARD_BLOCKS = [
    "NOME DIVERGENTE",
    "CPF INVÁLIDO",
    "CPF COM SITUAÇÃO IRREGULAR",
    "CPF NÃO ENCONTRADO",
    "CPF CONSTA OBITO",
    "CPF SOCIO DE CNAE IMPEDIDO",
    "CONSTA MANDADO DE PRISAO",
    //"CONSTAM 5 AÇÕES CIVEIS COMO AUTOR",
    "POSSUI ACAO CRIMINAL",
  ];

  const hit = motivos.find((m: string) => HARD_BLOCKS.includes(m));

  const risco = summary?.riscoCredito;
  const prob = summary?.probabilidadePagamento;

  const combo =
    risco === "ALTÍSSIMO" && (prob === "BAIXA" || prob === "BAIXÍSSIMA");

  return {
    isHardBlock: !!hit || combo,
    reasons: hit ? [hit] : combo ? ["RISCO_ALTISSIMO_PROB_BAIXA"] : [],
  };
}

// ===== Handler =====
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const started = Date.now();
  const traceId = crypto.randomUUID();

  const events: any[] = [];
  const mark = (step: string, ok: boolean, meta?: any) => {
    events.push({
      ts: nowIso(),
      ms: Date.now() - started,
      step,
      ok,
      meta: meta ?? undefined,
    });
  };

  let responseBody: any = null;

  let finalSource: AnalysisSource | null = null;
  let finalCacheHit = false;
  let finalDecision: Decision | null = null;
  let finalScore: number | null = null;
  let finalReasons: string[] = [];
  let finalRuleVersion = "mirror-v1";
  let cpfForLog: string | null = null;
  let input_summary: InputSummary | null = null;

  let imeiResultGlobal: NormalizedImeiResult | null = null;

  const supabaseMissingPolicy = envStr("SUPABASE_MISSING_POLICY", "continue"); // continue | fail
  const persistence = createSupabasePersistenceOrNull();

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, traceId, error: "Method not allowed" });
    }

    mark("request_received", true);

    console.log("🔥 ANALYZE HIT", new Date().toISOString());

    input_summary = buildInputSummary(req.body);
    cpfForLog = input_summary.cpf;


    const fingerprintSnapshot = input_summary?.device
      ? {
          ip: input_summary.device.ip ?? null,
          visitorId: input_summary.device.visitorId ?? null,
          os: input_summary.device.os ?? null,
          gpu: input_summary.device.gpu ?? null,
          cores: input_summary.device.cores ?? null,
          isMobile: input_summary.device.isMobile ?? null,
          osVersion: input_summary.device.osVersion ?? null,
          browserName: input_summary.device.browserName ?? null,
          screenWidthPhysical: input_summary.device.screenWidthPhysical ?? null,
          screenHeightPhysical: input_summary.device.screenHeightPhysical ?? null,
          fingerprintProvider: input_summary.device.fingerprintProvider ?? null,
        }
      : null;

    mark("fingerprint_snapshot", true, { hasFingerprint: !!fingerprintSnapshot });




    mark("input_summary_built", true, {
      hasImeiCode: !!input_summary?.imeiCode,
      imeiCode: input_summary?.imeiCode ?? null,
    });

    if (!cpfForLog) {
      mark("validate_input", false, { reason: "missing_cpf" });
      return res.status(400).json({ ok: false, traceId, error: "Missing cpf" });
    }

    mark("validate_input", true);

    if (!persistence) {
      const msg = "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY";
      console.error("[analyze] supabase missing", msg);

      if (supabaseMissingPolicy === "fail") {
        return res.status(500).json({ ok: false, traceId, error: "FUNCTION_INVOCATION_FAILED", details: msg });
      }

      mark("supabase_missing_continue", true);
    }

    // ===== 1) Cache GET =====
    let hit = null;
    let cacheGetMs = 0;

    if (persistence) {
      const t0 = Date.now();
      hit = await persistence.decisionCache.get(cpfForLog);
      cacheGetMs = Date.now() - t0;
      mark("cache_get", true, { hit: !!hit, cacheGetMs });
    } else {
      mark("cache_get_skipped_no_supabase", true);
    }

    if (hit) {
      finalSource = "cache";
      finalCacheHit = true;
      finalDecision = hit.decision;
      finalScore = hit.score;
      finalReasons = hit.reasons;
      finalRuleVersion = hit.ruleVersion;

      const totalMs = Date.now() - started;
      mark("response_sent", true, { source: "cache" });

      responseBody = {
        ok: true,
        traceId,
        source: "cache",
        cpf: cpfForLog,
        decision: finalDecision,
        score: finalScore,
        reasons: finalReasons,
        ruleVersion: finalRuleVersion,
        timingsMs: { cacheGetMs, totalMs },
        events,
        fingerprint: fingerprintSnapshot,
      };

      if (persistence) {
        await persistence.decisionAuditRepository.saveDecision({
          traceId,
          cpf: cpfForLog,
          source: finalSource,
          cacheHit: true,
          decision: finalDecision,
          score: finalScore,
          reasons: finalReasons,
          ruleVersion: finalRuleVersion,
          inputSummary: input_summary,
          events,
          latencyMs: totalMs,
        });
      }

      return res.status(200).json(responseBody);
    }

    // ===== 2) Enrichment =====
    const enrichTimeoutMs = envInt("ENRICHMENT_TIMEOUT_MS", 4000);
    const mode = envStr("ENRICHMENT_MODE", "mock");

    const providerInput = normalizeEnrichmentInput({ ...req.body, traceId });

    const enrichStarted = Date.now();
    let enrichResult: any = null;
    let enrichTimedOut = false;

    mark("enrichment_start", true, { mode, timeoutMs: enrichTimeoutMs });

    try {
      enrichResult = await Promise.race([
        techTrailEnrichmentProvider.enrich(providerInput),
        new Promise((_, reject) =>
          setTimeout(() => {
            enrichTimedOut = true;
            reject(new Error("ENRICHMENT_TIMEOUT"));
          }, enrichTimeoutMs)
        ),
      ]);
    } catch (err: any) {
      enrichResult = {
        ok: false,
        mode,
        provider: mode === "real" ? "techtrail" : "mock",
        ms: Date.now() - enrichStarted,
        httpStatus: null,
        requestParams: providerInput ? { cpf: providerInput.cpf } : { cpf: cpfForLog },
        raw: null,
        summary: null,
        error: { msg: err?.message ?? "ENRICHMENT_ERROR" },
      };
    }

    const enrichMs = Date.now() - enrichStarted;

    mark("enrichment_done", !!enrichResult?.ok, {
      mode,
      enrichMs,
      timedOut: enrichTimedOut,
      provider: enrichResult?.provider,
      httpStatus: enrichResult?.httpStatus ?? null,
    });

    // ===== 3) enrichment_raw =====
    if (persistence) {
      await persistence.providerRawRepository.saveEnrichment({
        traceId,
        cpf: cpfForLog,
        provider: enrichResult?.provider ?? "unknown",
        ok: !!enrichResult?.ok,
        mode: enrichResult?.mode ?? mode,
        httpStatus: enrichResult?.httpStatus ?? null,
        latencyMs: enrichResult?.ms ?? enrichMs,
        requestParams: enrichResult?.requestParams ?? null,
        responseJson: enrichResult?.raw ?? null,
        error: enrichResult?.ok ? null : enrichResult?.error ?? { msg: "ENRICHMENT_FAILED" },
      });
      mark("enrichment_raw_saved", true);
    } else {
      mark("enrichment_raw_skipped_no_supabase", true);
    }

    // ===== 4) Hard block + Score + decisão (ENGINE v1) =====
    let decision: Decision;
    let reasons: string[] = [];
    let score: number | null = null;
    let scoreBreakdown: ScoreBreakdownItem[] = [];
    const ruleVersion = "score-v1";

    let isTechFail = false;
    let isHardBlock = false;

    if (enrichResult?.ok && enrichResult?.summary) {
      const preEvaluation = preEvaluate(enrichResult, input_summary!);
      isHardBlock = preEvaluation.hardBlock.isHardBlock;

      mark("hard_block_check", true, {
        isHardBlock,
        reasons: preEvaluation.hardBlock.reasons,
      });

      if (isHardBlock) {
        const finalEvaluation = finalizeEvaluation(
          preEvaluation,
          null,
          0
        );

        decision = finalEvaluation.decision;
        reasons = finalEvaluation.reasons;
        score = finalEvaluation.score;
        scoreBreakdown = finalEvaluation.scoreBreakdown;
      } else {
        score = preEvaluation.baseScore;
        scoreBreakdown = preEvaluation.scoreBreakdown;
        const flags = preEvaluation.telemetryFlags!;

        const scoreComputedMeta = {
          score,
          breakdown: scoreBreakdown,
          flags,
        };
        mark("score_computed", true, scoreComputedMeta);

        // 4.3 IMEI opcional
        const imeiTimeoutMs = envInt("IMEI_TIMEOUT_MS", 20000);
        const imeiPenalty = envInt("SCORE_IMEI_PROBLEM", 5);

        let imeiResult: NormalizedImeiResult | null = null;

        if (input_summary?.imeiCode) {
          mark("imei_check_start", true, {
            hasImei: true,
            modeloDeclarado: input_summary?.modelo_declarado ?? null,
          });

          imeiResult = await imeiInfoProvider.check({
            imeiCode: input_summary.imeiCode,
            modeloDeclarado: input_summary.modelo_declarado,
            timeoutMs: imeiTimeoutMs,
          });

          imeiResultGlobal = imeiResult;

          if (persistence && imeiResult) {
            await persistence.providerRawRepository.saveImei({
              traceId,
              cpf: cpfForLog,
              imeiCode: input_summary?.imeiCode ?? null,
              modeloDeclarado: input_summary?.modelo_declarado ?? null,
              result: imeiResult,
            });
          }

          mark("imei_check_done", imeiResult.ok, {
            reason: imeiResult.reason,
            provider: imeiResult.provider,
            ms: imeiResult.ms,
            brandExpected: imeiResult.brandExpected ?? null,
            brandReturned: imeiResult.brandReturned ?? null,
            serviceId: imeiResult.serviceId ?? null,
            imeiSummary: imeiResult.summary ?? null,
          });
        } else {
          mark("imei_check_skipped", true, { reason: "missing_imei" });
        }

        const finalEvaluation = finalizeEvaluation(
          preEvaluation,
          imeiResult,
          imeiPenalty
        );

        decision = finalEvaluation.decision;
        reasons = finalEvaluation.reasons;
        score = finalEvaluation.score;
        scoreBreakdown = finalEvaluation.scoreBreakdown;
        const profile = finalEvaluation.profile;

        // Preserva o breakdown final observado no evento já registrado.
        scoreComputedMeta.breakdown = scoreBreakdown;

        mark("decision_profiled", true, {
          profile,
          decision,
          score,
          flags,
          imeiReason: imeiResult?.reason ?? null,
        });
      }
    } else {
      // 4.5 Falha técnica
      isTechFail = true;
      decision =
        envStr("ENRICHMENT_FAIL_DECISION", "DECLINE") === "APPROVE"
          ? "APPROVE"
          : "DECLINE";
      reasons = [enrichTimedOut ? "ENRICHMENT_TIMEOUT" : "ENRICHMENT_FAILED"];
      score = null;
      scoreBreakdown = [];
    }

    mark("decision_made", true, { decision, ruleVersion, isTechFail, isHardBlock, score });

    // ===== 5) Cache UPSERT (TTL diferente para techfail vs approve/decline) =====
    let cacheSetMs = 0;

    const ttlDaysApprove = envInt("CACHE_TTL_DAYS_APPROVE", envInt("CACHE_TTL_DAYS_APROVE", 30)); // compat typo
    const ttlDaysDecline = envInt("CACHE_TTL_DAYS_DECLINE", 30);
    const ttlSecondsTechFail = envInt("CACHE_TTL_SECONDS_ON_TECH_FAIL", 300);

    let ttlKind: "days" | "seconds" = "days";
    let ttlValue = 30;

    if (isTechFail) {
      ttlKind = "seconds";
      ttlValue = ttlSecondsTechFail;
    } else {
      ttlKind = "days";
      ttlValue = decision === "APPROVE" ? ttlDaysApprove : ttlDaysDecline;
    }

    let expiresAt: string | null = null;

    if (persistence) {
      const cacheSetStarted = Date.now();
      expiresAt = await persistence.decisionCache.set({
        cpf: cpfForLog,
        decision,
        score,
        reasons,
        ruleVersion,
        ttlKind,
        ttlValue,
        updatedAtIso: nowIso(),
      });
      cacheSetMs = Date.now() - cacheSetStarted;

      mark("cache_set", !!expiresAt, {
        ttlKind,
        ttlValue,
        expiresAt: expiresAt ?? null,
        cacheSetMs,
      });
    } else {
      mark("cache_set_skipped_no_supabase", true);
    }

    // ===== 6) Resposta final =====
    finalSource = "engine";
    finalCacheHit = false;
    finalDecision = decision;
    finalScore = score;
    finalReasons = reasons;
    finalRuleVersion = ruleVersion;

    const totalMs = Date.now() - started;
    mark("response_sent", true, { source: "engine" });

    responseBody = {
      ok: true,
      traceId,
      source: "engine",
      cpf: cpfForLog,
      decision: finalDecision,
      score: finalScore,
      reasons: finalReasons,
      ruleVersion: finalRuleVersion,
      timingsMs: { cacheGetMs, enrichMs, cacheSetMs, totalMs },
      // debug / calibração (tira depois se quiser)
      scoreBreakdown,
      events,
      fingerprint: fingerprintSnapshot,
      imei: imeiResultGlobal
        ? {
            reason: imeiResultGlobal.reason,
            brandExpected: imeiResultGlobal.brandExpected ?? null,
            brandReturned: imeiResultGlobal.brandReturned ?? null,
            summary: imeiResultGlobal.summary ?? null,
          }
        : null,
    };

    // ===== 7) LOG ÚNICO =====
    if (persistence) {
      await persistence.decisionAuditRepository.saveDecision({
        traceId,
        cpf: cpfForLog,
        source: finalSource,
        cacheHit: finalCacheHit,
        decision: finalDecision,
        score: finalScore,
        reasons: finalReasons,
        ruleVersion: finalRuleVersion,
        inputSummary: input_summary,
        events,
        latencyMs: totalMs,
      });
    }

    return res.status(200).json(responseBody);
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
