// src/providers/enrichment.ts
export type EnrichmentMode = "off" | "mock" | "real";

export type EnrichmentCallInput = {
  traceId: string;
  cpf: string;
  nome?: string | null;
  email?: string | null;
  telefone_contato?: string | null;
  valor_celular?: number | null;
  cep?: string | null;

  partnerCode?: string | null;
  salesChannel?: string | null;
  proposalId?: string | null;
  sessionId?: string | null;
};

export type EnrichmentResult = {
  ok: boolean;
  mode: EnrichmentMode;
  provider: "techtrail" | "mock";
  ms: number;

  httpStatus?: number | null;

  // auditoria: exatamente o que enviamos (já normalizado)
  requestParams: Record<string, any>;

  // resposta completa (raw) quando existir
  raw?: any;

  // resumo para o motor/log (pequeno)
  summary?: {
    providerDecision?: "ACEITO" | "DECLINADO" | null;
    motivos?: string[];
    riscoCredito?: string | null;
    probabilidadePagamento?: string | null;
    quantidadeProcessos?: number | null;
    mandadoPrisao?: boolean | null;
    pessoaExpostaPoliticamente?: string | null;
    percentualAssertividadeNome?: number | null;
    situacaoCpf?: string | null;
  };

  error?: { msg: string; code?: string; detail?: any };
};

function onlyDigits(s: string) {
  return (s || "").replace(/\D/g, "");
}

function normEmail(s: any) {
  if (!s) return null;
  return String(s).trim().toLowerCase();
}

/**
 * CEP no Brasil é 8 dígitos.
 * - se vier >8 (ex.: "123456789"), pega os 8 primeiros (não estoura)
 * - se vier <8, manda o que tiver (às vezes o provider tolera) ou null se vazio
 */
function normCep(s: any) {
  const d = onlyDigits(String(s ?? ""));
  if (!d) return null;
  if (d.length === 8) return d;
  if (d.length > 8) return d.slice(0, 8);
  return d; // len < 8
}

function normPhone(s: any) {
  const d = onlyDigits(String(s ?? ""));
  return d || null;
}

function toNumberOrNull(v: any) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function envInt(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function envStr(name: string, fallback: string) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export function buildRequestParams(input: EnrichmentCallInput) {
  // “Contrato” do que mandamos pra Techtrail
  // Mesmo em mock, montamos igual.
  return {
    cpf: input.cpf,
    nome: input.nome ?? "",
    email: input.email ?? "",
    telefone_contato: input.telefone_contato ?? "",
    valor_celular: input.valor_celular ?? "",
    cep: input.cep ?? "",
    partnerCode: input.partnerCode ?? null,
    salesChannel: input.salesChannel ?? null,
    proposalId: input.proposalId ?? null,
    sessionId: input.sessionId ?? null,
  };
}

export function normalizeInput(body: any): EnrichmentCallInput {
  const cpf = onlyDigits(String(body.cpf ?? ""));
  return {
    traceId: String(body.traceId ?? ""),
    cpf,
    nome: body.nome ? String(body.nome).trim() : null,
    email: normEmail(body.email),
    telefone_contato: normPhone(body.telefone_contato),
    valor_celular: toNumberOrNull(body.valor_celular),
    cep: normCep(body.cep),

    partnerCode: body.partnerCode ? String(body.partnerCode) : null,
    salesChannel: body.salesChannel ? String(body.salesChannel) : null,
    proposalId: body.proposalId ? String(body.proposalId) : null,
    sessionId: body.sessionId ? String(body.sessionId) : null,
  };
}

function parseProviderDecision(v: any): "ACEITO" | "DECLINADO" | null {
  if (v === "ACEITO" || v === "DECLINADO") return v;
  return null;
}

function pickString(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function pickNumber(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickBool(v: any): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  // algumas APIs retornam "true"/"false" ou 0/1
  if (v === "true" || v === "1" || v === 1) return true;
  if (v === "false" || v === "0" || v === 0) return false;
  return null;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function enrich(input: EnrichmentCallInput): Promise<EnrichmentResult> {
  const started = Date.now();
  const mode = (process.env.ENRICHMENT_MODE ?? "mock") as EnrichmentMode;

  const requestParams = buildRequestParams(input);

  if (mode === "off") {
    return {
      ok: true,
      mode,
      provider: "mock",
      ms: Date.now() - started,
      requestParams,
      raw: null,
      summary: { providerDecision: null, motivos: ["ENRICHMENT_OFF"] },
    };
  }

  if (mode === "mock") {
    const mockMs = envInt("ENRICHMENT_MOCK_MS", 80);
    await sleep(mockMs);

    // determinístico: último dígito do cpf define decisão
    const last = Number(input.cpf.slice(-1) || "0");
    const providerDecision: "ACEITO" | "DECLINADO" = last % 2 === 0 ? "ACEITO" : "DECLINADO";

    const raw = {
      cpf: input.cpf,
      nomeBase: input.nome ?? "",
      nomeInformado: input.nome ?? "",
      percentualAssertividadeNome: 95,
      emailInformado: input.email ?? "",
      emailBase: input.email ?? "",
      telefoneInformado: input.telefone_contato ?? "",
      telefoneBase: input.telefone_contato ?? "",
      cepInformado: input.cep ?? "",
      cepBase: input.cep ?? "",
      enderecoResidencia: "",
      idade: 30,
      situacaoCpf: "REGULAR",
      nomeMae: "",
      dataNascimento: "",
      mandadoPrisao: false,
      escolaridade: "",
      profissao: "",
      faixaRenda: "",
      aposentadoria: "",
      tipoAposentadoria: "",
      pessoaExpostaPoliticamente: "NAO",
      decisao: providerDecision,
      processos: [],
      quantidadeProcessos: 0,
      dataUltimoProcesso: "",
      empresasFuncionario: [],
      empresasSocio: [],
      motivos: providerDecision === "ACEITO" ? ["MOCK_OK"] : ["MOCK_DECLINED"],
      riscoCredito: "MEDIO",
      probabilidadePagamento: "MEDIA",
    };

    return {
      ok: true,
      mode,
      provider: "mock",
      ms: Date.now() - started,
      httpStatus: 200,
      requestParams,
      raw,
      summary: {
        providerDecision,
        motivos: raw.motivos,
        riscoCredito: raw.riscoCredito,
        probabilidadePagamento: raw.probabilidadePagamento,
        quantidadeProcessos: raw.quantidadeProcessos,
        mandadoPrisao: raw.mandadoPrisao,
        pessoaExpostaPoliticamente: raw.pessoaExpostaPoliticamente,
        percentualAssertividadeNome: raw.percentualAssertividadeNome,
        situacaoCpf: raw.situacaoCpf,
      },
    };
  }

  // mode === "real"
  const baseUrl = envStr("ENRICHMENT_URL_BASE", "https://apitechtrail.com.br/api/segcelular/pf");
  const auth = envStr("ENRICHMENT_AUTH", "");
  const timeoutMs = envInt("ENRICHMENT_TIMEOUT_MS", 4000);

  if (!auth) {
    return {
      ok: false,
      mode,
      provider: "techtrail",
      ms: Date.now() - started,
      requestParams,
      error: { msg: "Missing ENRICHMENT_AUTH" },
    };
  }

  // monta query string com encoding correto (espaços etc.)
  const qs = new URLSearchParams();
  qs.set("cpf", requestParams.cpf ?? "");
  qs.set("nome", requestParams.nome ?? "");
  qs.set("email", requestParams.email ?? "");
  qs.set("telefone_contato", requestParams.telefone_contato ?? "");
  qs.set("valor_celular", String(requestParams.valor_celular ?? ""));
  qs.set("cep", requestParams.cep ?? "");

  const url = `${baseUrl}?${qs.toString()}`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          Authorization: auth, // "Basic TOKEN"
          Accept: "application/json",
        },
      },
      timeoutMs
    );

    const httpStatus = res.status;

    // Pode vir JSON, texto, ou qualquer coisa. Parse defensivo.
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        mode,
        provider: "techtrail",
        ms: Date.now() - started,
        httpStatus,
        requestParams,
        raw: json ?? { nonJson: text?.slice(0, 500) },
        error: {
          msg: "TECHTRAIL_HTTP_ERROR",
          code: String(httpStatus),
          detail: json ?? text?.slice(0, 500),
        },
      };
    }

    // Se veio 200 mas não é JSON, trata como falha (pra não tomar decisão errada)
    if (!json || typeof json !== "object") {
      return {
        ok: false,
        mode,
        provider: "techtrail",
        ms: Date.now() - started,
        httpStatus,
        requestParams,
        raw: { nonJson: text?.slice(0, 500) },
        error: { msg: "TECHTRAIL_INVALID_JSON", detail: text?.slice(0, 500) },
      };
    }

    // Extrai campos conhecidos do payload deles (pelo exemplo que você colou)
    const providerDecision = parseProviderDecision(json.decisao);
    const motivos = Array.isArray(json.motivos) ? json.motivos.map(String).filter(Boolean) : [];

    const summary: EnrichmentResult["summary"] = {
      providerDecision,
      motivos,
      riscoCredito: pickString(json.riscoCredito),
      probabilidadePagamento: pickString(json.probabilidadePagamento),
      quantidadeProcessos: pickNumber(json.quantidadeProcessos),
      mandadoPrisao: pickBool(json.mandadoPrisao),
      pessoaExpostaPoliticamente: pickString(json.pessoaExpostaPoliticamente),
      percentualAssertividadeNome: pickNumber(json.percentualAssertividadeNome),
      situacaoCpf: pickString(json.situacaoCpf),
    };

    return {
      ok: true,
      mode,
      provider: "techtrail",
      ms: Date.now() - started,
      httpStatus,
      requestParams,
      raw: json,
      summary,
    };
  } catch (err: any) {
    const msg = err?.name === "AbortError" ? "TECHTRAIL_TIMEOUT" : "TECHTRAIL_FETCH_FAILED";
    return {
      ok: false,
      mode,
      provider: "techtrail",
      ms: Date.now() - started,
      httpStatus: null,
      requestParams,
      raw: null,
      error: { msg, detail: err?.message ?? String(err) },
    };
  }
}
