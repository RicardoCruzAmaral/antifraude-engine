// src/providers/imei.ts
export type ImeiResult = {
  ok: boolean;
  provider: "mock" | "real";
  ms: number;
  httpStatus: number | null;
  raw: any;
  error?: { msg: string };
};

function envInt(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function envStr(name: string, fallback: string) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function imeiCheck(input: {
  traceId: string;
  cpf: string;
  imei?: string | null;
}): Promise<ImeiResult> {
  const started = Date.now();

  const mode = envStr("IMEI_MODE", "mock").toLowerCase(); // se não existir, mock
  if (mode === "mock") {
    // simula latência
    await sleep(envInt("IMEI_MOCK_MS", 120));

    // mock determinístico: último dígito do cpf
    const last = Number(input.cpf.slice(-1) || "0");
    const ok = last % 2 === 0;

    return {
      ok,
      provider: "mock",
      ms: Date.now() - started,
      httpStatus: 200,
      raw: { mock: true, ok },
    };
  }

  // modo real: você pluga depois a URL/token reais
  return {
    ok: false,
    provider: "real",
    ms: Date.now() - started,
    httpStatus: null,
    raw: null,
    error: { msg: "IMEI_MODE=real ainda não implementado" },
  };
}