// api/analyze.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { enrich, normalizeInput } from "../src/providers/enrichment";
import { computeFlags } from "../src/engine/decision";

// (mantive os imports que você tinha; ainda não usamos o decision engine aqui)
import { imeiCheck } from "../src/providers/imei";

// ===== Tipos =====
type Decision = "APPROVE" | "DECLINE";
type Source = "cache" | "engine";

type InputSummary = {
  cpf: string | null;
  nome: string | null;
  email: string | null;
  telefone_contato: string | null;
  valor_celular: number | null;
  cep: string | null;
  imeiCode: string | null;

  modelo_declarado: string | null;

  partnerCode: string | null;
  salesChannel: string | null;
  proposalId: string | null;
  sessionId: string | null;

  device: any | null;
};

type CacheRow = {
  cpf: string;
  decision: Decision;
  score: number | null;
  reasons: string[];
  rule_version: string;
  expires_at: string;
};

type ImeiResult = {
  ok: boolean;
  provider: "mock" | "imei_provider";
  ms: number;
  httpStatus?: number | null;
  timedOut?: boolean;
  reason?: string; // "IMEI_OK" / "IMEI_FAIL" / "IMEI_TIMEOUT"
};

type ScoreBreakdownItem = { rule: string; points: number };
type ScoreResult = { score: number; breakdown: ScoreBreakdownItem[] };

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
function addDaysIso(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}
function addSecondsIso(seconds: number) {
  const d = new Date();
  d.setSeconds(d.getSeconds() + seconds);
  return d.toISOString();
}
function normEnum(s: any): string {
  if (!s) return "";
  return String(s)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, ""); // remove acentos: "ALTÍSSIMO" -> "ALTISSIMO"
}
function hasReason(reasons: string[], target: string) {
  const t = normEnum(target);
  return reasons.some((r) => normEnum(r) === t);
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

// ===== Supabase client =====
function getSupabaseOrNull() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) return null;

  return createClient(url, key, { auth: { persistSession: false } });
}

// ===== Cache =====
async function cacheGet(supabase: any, cpf: string): Promise<CacheRow | null> {
  try {
    const { data, error } = await supabase
      .from("decision_cache")
      .select("cpf, decision, score, reasons, rule_version, expires_at")
      .eq("cpf", cpf)
      .gt("expires_at", nowIso())
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  } catch (err: any) {
    console.error("[cacheGet] failed", err);
    return null;
  }
}

async function cacheUpsert(
  supabase: any,
  input: {
    cpf: string;
    decision: Decision;
    score: number | null;
    reasons: string[];
    ruleVersion: string;
    ttlKind: "days" | "seconds";
    ttlValue: number;
    updatedAtIso: string;
  }
) {
  try {
    const expiresAt = input.ttlKind === "seconds" ? addSecondsIso(input.ttlValue) : addDaysIso(input.ttlValue);

    const { error } = await supabase
      .from("decision_cache")
      .upsert(
        {
          cpf: input.cpf,
          decision: input.decision,
          score: input.score,
          reasons: input.reasons,
          rule_version: input.ruleVersion,
          expires_at: expiresAt,
          updated_at: input.updatedAtIso,
        },
        { onConflict: "cpf" }
      );

    if (error) throw error;
    return expiresAt;
  } catch (err: any) {
    console.error("[cacheUpsert] failed", err);
    return null;
  }
}

// ===== Decision log =====
async function safeLogDecision(
  supabase: any,
  row: {
    trace_id: string;
    cpf: string | null;
    source: Source;
    cache_hit: boolean;
    decision: Decision;
    score: number | null;
    reasons: string[];
    rule_version: string;
    input_summary: any;
    events: any[];
    latency_ms: number;
  }
) {
  try {
    const { error } = await supabase.from("decision_log").insert({
      trace_id: row.trace_id,
      cpf: row.cpf,
      source: row.source,
      cache_hit: row.cache_hit,
      decision: row.decision,
      score: row.score,
      reasons: row.reasons,
      rule_version: row.rule_version,
      input_summary: row.input_summary,
      events: row.events,
      latency_ms: row.latency_ms,
      created_at: nowIso(),
    });
    if (error) throw error;
  } catch (err: any) {
    console.error("[decision_log] insert failed", { trace_id: row.trace_id, err });
  }
}

// ===== Enrichment raw =====
async function safeInsertEnrichmentRaw(
  supabase: any,
  row: {
    trace_id: string;
    cpf: string;
    provider: string;
    ok: boolean;
    mode: string;
    http_status: number | null;
    latency_ms: number | null;
    request_params: any;
    response_json: any;
    error: any;
  }
) {
  try {
    const { error } = await supabase.from("enrichment_raw").insert({
      trace_id: row.trace_id,
      cpf: row.cpf,
      provider: row.provider,
      ok: row.ok,
      mode: row.mode,
      http_status: row.http_status,
      latency_ms: row.latency_ms,
      request_params: row.request_params,
      response_json: row.response_json,
      error: row.error,
      created_at: nowIso(),
    });
    if (error) throw error;
  } catch (err: any) {
    console.error("[enrichment_raw] insert failed", { trace_id: row.trace_id, err });
  }
}

// ===== IMEI mock =====
async function imeiCheckMock(timeoutMs: number): Promise<ImeiResult> {
  const started = Date.now();
  const mockMs = envInt("IMEI_MOCK_MS", 120);
  let timedOut = false;

  try {
    const r = await Promise.race([
      new Promise<ImeiResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: true,
              provider: "mock",
              ms: Date.now() - started,
              httpStatus: 200,
              reason: "IMEI_OK",
            }),
          mockMs
        )
      ),
      new Promise<ImeiResult>((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          reject(new Error("IMEI_TIMEOUT"));
        }, timeoutMs)
      ),
    ]);
    return r;
  } catch {
    return {
      ok: false,
      provider: "mock",
      ms: Date.now() - started,
      httpStatus: null,
      timedOut,
      reason: timedOut ? "IMEI_TIMEOUT" : "IMEI_FAIL",
    };
  }
}

// ===== HARD BLOCKS (TechTrail + combo risco/prob) =====
function detectHardBlock(enrichResult: any): { isHardBlock: boolean; reasons: string[] } {
  const motivos: string[] = Array.isArray(enrichResult?.summary?.motivos) ? enrichResult.summary.motivos : [];

  const hardMotivos = [
    "NOME DIVERGENTE",
    "CPF INVÁLIDO",
    "CPF COM SITUAÇÃO IRREGULAR",
    "CPF NÃO ENCONTRADO",
    "CPF CONSTA OBITO",
    "CPF SOCIO DE CNAE IMPEDIDO",
    "CONSTA MANDADO DE PRISAO",
    "CONSTAM 5 AÇÕES CIVEIS COMO AUTOR",
    "POSSUI ACAO CRIMINAL",
    // se a TechTrail mandar com variação mínima, o normEnum segura bem
  ];

  const hitHard = hardMotivos.filter((m) => hasReason(motivos, m));
  const risco = normEnum(enrichResult?.summary?.riscoCredito);
  const prob = normEnum(enrichResult?.summary?.probabilidadePagamento);

  const comboHard = risco === "ALTISSIMO" && (prob === "BAIXA" || prob === "BAIXISSIMA");
  const comboReasons = comboHard ? ["HARD_BLOCK_RISCO_PROB"] : [];

  const finalReasons = [...hitHard, ...comboReasons];
  return { isHardBlock: finalReasons.length > 0, reasons: finalReasons };
}

// ===== SCORE (parametrizável por env, com defaults) =====
function computeScoreLocal(enrichResult: any, input: InputSummary): ScoreResult {

  console.log("✅ DEBUG computeScoreLocal ENTER");

  const breakdown: ScoreBreakdownItem[] = [];
  const motivos: string[] = Array.isArray(enrichResult?.summary?.motivos)
    ? enrichResult.summary.motivos
    : [];

  console.log("motivos:", motivos);

  // Divergências cadastrais (motivos)
  const P_EMAIL = envInt("SCORE_EMAIL_DIVERGENTE", 5);
  const P_TEL = envInt("SCORE_TELEFONE_DIVERGENTE", 5);
  const P_CEP = envInt("SCORE_CEP_DIVERGENTE", 5);

  if (hasReason(motivos, "EMAIL DIVERGENTE")) breakdown.push({ rule: "EMAIL_DIVERGENTE", points: P_EMAIL });
  if (hasReason(motivos, "TELEFONE DIVERGENTE")) breakdown.push({ rule: "TELEFONE_DIVERGENTE", points: P_TEL });
  if (hasReason(motivos, "CEP DIVERGENTE")) breakdown.push({ rule: "CEP_DIVERGENTE", points: P_CEP });

  // riscoCredito
  const risco = normEnum(enrichResult?.summary?.riscoCredito);
  const riscoMap: Record<string, number> = {
    ALTISSIMO: envInt("SCORE_RISCO_ALTISSIMO", 20),
    ALTO: envInt("SCORE_RISCO_ALTO", 15),
    MEDIO: envInt("SCORE_RISCO_MEDIO", 10),
    BAIXO: envInt("SCORE_RISCO_BAIXO", 5),
    BAIXISSIMO: envInt("SCORE_RISCO_BAIXISSIMO", 0),
  };
  if (risco && riscoMap[risco] !== undefined) breakdown.push({ rule: `RISCO_${risco}`, points: riscoMap[risco] });

  // probabilidadePagamento (invertido) — valores vêm: ALTA / ALTÍSSIMA / MÉDIA / BAIXA / BAIXÍSSIMA
  const prob = normEnum(enrichResult?.summary?.probabilidadePagamento);

  const probMap: Record<string, number> = {
    ALTISSIMA: envInt("SCORE_PROB_ALTISSIMA", 0),
    ALTA: envInt("SCORE_PROB_ALTA", 5),
    MEDIA: envInt("SCORE_PROB_MEDIA", 10),
    BAIXA: envInt("SCORE_PROB_BAIXA", 15),
    BAIXISSIMA: envInt("SCORE_PROB_BAIXISSIMA", 20),
  };

  if (prob && probMap[prob] !== undefined) {
    breakdown.push({ rule: `PROB_${prob}`, points: probMap[prob] });
  }

  // quantidadeProcessos
  const qpRaw = enrichResult?.summary?.quantidadeProcessos;
  const qp = Number.isFinite(Number(qpRaw)) ? Number(qpRaw) : 0;
  const P_PROC_1_3 = envInt("SCORE_PROC_1_3", 10);
  const P_PROC_4_5 = envInt("SCORE_PROC_4_5", 20);
  const P_PROC_GT_5 = envInt("SCORE_PROC_GT_5", 25);

  if (qp > 0 && qp <= 3) breakdown.push({ rule: "PROCESSOS_1_3", points: P_PROC_1_3 });
  else if (qp > 3 && qp <= 5) breakdown.push({ rule: "PROCESSOS_4_5", points: P_PROC_4_5 });
  else if (qp > 5) breakdown.push({ rule: "PROCESSOS_GT_5", points: P_PROC_GT_5 });

  // valor_celular high value
  const highMin = envInt("VALOR_CELULAR_HIGH_VALUE_MIN", 5000);
  const highPts = envInt("SCORE_VALOR_CELULAR_HIGH_VALUE", 10);

  if (typeof input.valor_celular === "number" && input.valor_celular > highMin) {
    breakdown.push({ rule: "VALOR_CELULAR_HIGH_VALUE", points: highPts });
  }

  const score = breakdown.reduce((acc, x) => acc + x.points, 0);
  return { score, breakdown };
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
    "CONSTAM 5 AÇÕES CIVEIS COMO AUTOR",
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
    "CONSTAM 5 AÇÕES CIVEIS COMO AUTOR",
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

function classifyProfileByScore(score: number): "A" | "B1" | "B2" | "C" {
  if (score <= 10) return "A";
  if (score <= 25) return "B1";
  if (score <= 40) return "B2";
  return "C";
}


function computeFlags(enrichResult: any, input: any) {
  const motivos = Array.isArray(enrichResult?.summary?.motivos)
    ? enrichResult.summary.motivos
    : [];

  return {
    // hard blocks do fingerprint (quando você ligar)
    nonMobile: input?.device?.isMobile === false,

    // divergências básicas (se a techtrail mandar como motivo)
    emailDivergente: motivos.includes("EMAIL DIVERGENTE"),
    telefoneDivergente: motivos.includes("TELEFONE DIVERGENTE"),
    cepDivergente: motivos.includes("CEP DIVERGENTE"),

    // risco (se vier no summary)
    riscoCredito: enrichResult?.summary?.riscoCredito ?? null,
    probabilidadePagamento: enrichResult?.summary?.probabilidadePagamento ?? null,

    // processos
    quantidadeProcessos: enrichResult?.summary?.quantidadeProcessos ?? null,
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

  let finalSource: Source | null = null;
  let finalCacheHit = false;
  let finalDecision: Decision | null = null;
  let finalScore: number | null = null;
  let finalReasons: string[] = [];
  let finalRuleVersion = "mirror-v1";
  let cpfForLog: string | null = null;
  let input_summary: InputSummary | null = null;

  const supabaseMissingPolicy = envStr("SUPABASE_MISSING_POLICY", "continue"); // continue | fail
  const supabase = getSupabaseOrNull();

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, traceId, error: "Method not allowed" });
    }

    mark("request_received", true);

    console.log("🔥 ANALYZE HIT", new Date().toISOString());

    input_summary = buildInputSummary(req.body);
    cpfForLog = input_summary.cpf;
    
    mark("input_summary_built", true, {
      hasImeiCode: !!input_summary?.imeiCode,
      imeiCode: input_summary?.imeiCode ?? null,
    });

    if (!cpfForLog) {
      mark("validate_input", false, { reason: "missing_cpf" });
      return res.status(400).json({ ok: false, traceId, error: "Missing cpf" });
    }

    mark("validate_input", true);

    if (!supabase) {
      const msg = "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY";
      console.error("[analyze] supabase missing", msg);

      if (supabaseMissingPolicy === "fail") {
        return res.status(500).json({ ok: false, traceId, error: "FUNCTION_INVOCATION_FAILED", details: msg });
      }

      mark("supabase_missing_continue", true);
    }

    // ===== 1) Cache GET =====
    let hit: CacheRow | null = null;
    let cacheGetMs = 0;

    if (supabase) {
      const t0 = Date.now();
      hit = await cacheGet(supabase, cpfForLog);
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
      finalRuleVersion = hit.rule_version;

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
      };

      if (supabase) {
        await safeLogDecision(supabase, {
          trace_id: traceId,
          cpf: cpfForLog,
          source: finalSource,
          cache_hit: true,
          decision: finalDecision,
          score: finalScore,
          reasons: finalReasons,
          rule_version: finalRuleVersion,
          input_summary,
          events,
          latency_ms: totalMs,
        });
      }

      return res.status(200).json(responseBody);
    }

    // ===== 2) Enrichment =====
    const enrichTimeoutMs = envInt("ENRICHMENT_TIMEOUT_MS", 4000);
    const mode = envStr("ENRICHMENT_MODE", "mock");

    const providerInput = normalizeInput({ ...req.body, traceId });

    const enrichStarted = Date.now();
    let enrichResult: any = null;
    let enrichTimedOut = false;

    mark("enrichment_start", true, { mode, timeoutMs: enrichTimeoutMs });

    try {
      enrichResult = await Promise.race([
        enrich(providerInput),
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
    if (supabase) {
      await safeInsertEnrichmentRaw(supabase, {
        trace_id: traceId,
        cpf: cpfForLog,
        provider: enrichResult?.provider ?? "unknown",
        ok: !!enrichResult?.ok,
        mode: enrichResult?.mode ?? mode,
        http_status: enrichResult?.httpStatus ?? null,
        latency_ms: enrichResult?.ms ?? enrichMs,
        request_params: enrichResult?.requestParams ?? null,
        response_json: enrichResult?.raw ?? null,
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
      // 4.1 Hard block logo após enriquecimento
      const hb = detectHardBlock(enrichResult);
      isHardBlock = hb.isHardBlock;

      mark("hard_block_check", true, {
        isHardBlock,
        reasons: hb.reasons,
      });

      if (isHardBlock) {
        decision = "DECLINE";
        reasons = hb.reasons;
        score = null;
        scoreBreakdown = [];
      } else {
        // 4.2 Score
        console.log("🟦 about to call computeScoreLocal");
        const s = computeScoreLocal(enrichResult, input_summary!);
        console.log("🟩 returned from computeScoreLocal", s);

        // 🔒 GARANTIAS
        score = Number.isFinite(s?.total)
          ? s.total
          : Number.isFinite(s?.score)
          ? s.score
          : 0;

        scoreBreakdown = Array.isArray(s?.breakdown) ? s.breakdown : [];

        // ✅ FLAGS (aqui)
        const flags = computeFlags(enrichResult, input_summary!);

        mark("score_computed", true, {
          score,
          breakdown: scoreBreakdown,
          flags,
        });

        // 4.3 Perfil
        const profile = classifyProfileByScore(score);

        // 4.4 Decisão por perfil
        decision = profile === "C" ? "DECLINE" : "APPROVE";

        reasons = scoreBreakdown.map((b) => b.rule);

        mark("decision_profiled", true, {
          profile,
          decision,
          score,
          flags,
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


    // ===== 4.1) IMEI (ainda opcional/mock) =====
    const imeiPolicy = envStr("IMEI_POLICY", "off"); // off | always_mock
    const imeiTimeoutMs = envInt("IMEI_TIMEOUT_MS", 4000);

    // NÃO roda IMEI se hard block já derrubou ou se tech fail
    if (!isHardBlock && !isTechFail && imeiPolicy === "always_mock") {
      mark("imei_check_start", true, { timeoutMs: imeiTimeoutMs });

      const imeiStarted = Date.now();
      const imeiRes = await imeiCheckMock(imeiTimeoutMs);
      const imeiMs = Date.now() - imeiStarted;

      mark("imei_check_done", imeiRes.ok, {
        imeiMs,
        timedOut: !!imeiRes.timedOut,
        provider: imeiRes.provider,
        httpStatus: imeiRes.httpStatus ?? null,
      });

      if (imeiRes.ok) reasons = [...reasons, "IMEI_OK"];
      else reasons = [...reasons, imeiRes.reason ?? "IMEI_FAIL"];
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

    if (supabase) {
      const cacheSetStarted = Date.now();
      expiresAt = await cacheUpsert(supabase, {
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
    };

    // ===== 7) LOG ÚNICO =====
    if (supabase) {
      await safeLogDecision(supabase, {
        trace_id: traceId,
        cpf: cpfForLog,
        source: finalSource,
        cache_hit: finalCacheHit,
        decision: finalDecision,
        score: finalScore,
        reasons: finalReasons,
        rule_version: finalRuleVersion,
        input_summary,
        events,
        latency_ms: totalMs,
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
