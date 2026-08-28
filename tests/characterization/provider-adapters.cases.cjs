const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadProviderAdaptersForCharacterization,
  withIsolatedEnvironmentAsync,
} = require("../helpers/analyze-characterization-harness.cjs");

const { enrichment, imei } = loadProviderAdaptersForCharacterization();
const {
  normalizeEnrichmentInput,
  techTrailEnrichmentProvider,
} = enrichment;
const { imeiInfoProvider } = imei;

const SYNTHETIC_VALID_IMEI = "000000000000000";
const SYNTHETIC_FORMATTED_IMEI = "000-000-000-000-000";
const SYNTHETIC_INVALID_IMEI = "000000000000001";

const REAL_ENRICHMENT_ENV = {
  ENRICHMENT_MODE: "real",
  ENRICHMENT_URL_BASE: "https://techtrail.example.invalid/pf",
  ENRICHMENT_AUTH: " synthetic-test-auth ",
  ENRICHMENT_TIMEOUT_MS: "50",
};

const IMEI_ENV = {
  IMEI_INFO_API_KEY: "synthetic-test-api-key",
};

async function withFetchStub(fetchStub, callback) {
  const originalFetch = global.fetch;
  global.fetch = fetchStub;
  try {
    return await callback();
  } finally {
    global.fetch = originalFetch;
  }
}

function textResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function abortingFetch() {
  return async (_url, init) =>
    new Promise((_, reject) => {
      if (init.signal.aborted) {
        reject(abortError("synthetic-test-aborted"));
        return;
      }

      init.signal.addEventListener(
        "abort",
        () => reject(abortError("synthetic-test-aborted")),
        { once: true }
      );
    });
}

function normalizedEnrichmentInput(overrides = {}) {
  return normalizeEnrichmentInput({
    traceId: "synthetic-test-trace",
    cpf: "000.000.000-00",
    nome: " PESSOA SINTETICA ",
    email: " PROVIDER-TEST@EXAMPLE.INVALID ",
    telefone_contato: "(00) 00000-0000",
    valor_celular: "123.5",
    cep: "00000-0009",
    partnerCode: "synthetic-test-partner",
    salesChannel: "synthetic-test-channel",
    proposalId: "synthetic-test-proposal",
    sessionId: "synthetic-test-session",
    ...overrides,
  });
}

async function runRealEnrichment(fetchStub, callback) {
  return withIsolatedEnvironmentAsync(REAL_ENRICHMENT_ENV, () =>
    withFetchStub(fetchStub, callback)
  );
}

async function runImeiCheck(input, fetchStub, env = {}) {
  return withIsolatedEnvironmentAsync({ ...IMEI_ENV, ...env }, () =>
    withFetchStub(fetchStub, () => imeiInfoProvider.check(input))
  );
}

function assertImeiRequest(call, serviceId) {
  const url = new URL(call.url);
  assert.equal(
    `${url.origin}${url.pathname}`,
    `https://dash.imei.info/api-sync/check/${serviceId}`
  );
  assert.equal(url.searchParams.get("API_KEY"), "synthetic-test-api-key");
  assert.equal(url.searchParams.get("imei"), SYNTHETIC_VALID_IMEI);
  assert.equal(call.init.method, "GET");
  assert.ok(call.init.signal instanceof AbortSignal);
}

test("TechTrail off preserva normalização e não chama fetch", async () => {
  let fetchCalls = 0;
  const input = normalizedEnrichmentInput();

  assert.deepEqual(input, {
    traceId: "synthetic-test-trace",
    cpf: "00000000000",
    nome: "PESSOA SINTETICA",
    email: "provider-test@example.invalid",
    telefone_contato: "00000000000",
    valor_celular: 123.5,
    cep: "00000000",
    partnerCode: "synthetic-test-partner",
    salesChannel: "synthetic-test-channel",
    proposalId: "synthetic-test-proposal",
    sessionId: "synthetic-test-session",
  });

  const result = await withIsolatedEnvironmentAsync(
    { ENRICHMENT_MODE: "off" },
    () =>
      withFetchStub(async () => {
        fetchCalls += 1;
        throw new Error("UNEXPECTED_FETCH");
      }, () => techTrailEnrichmentProvider.enrich(input))
  );

  assert.equal(fetchCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "off");
  assert.equal(result.provider, "mock");
  assert.equal(result.raw, null);
  assert.deepEqual(result.requestParams, {
    cpf: "00000000000",
    nome: "PESSOA SINTETICA",
    email: "provider-test@example.invalid",
    telefone_contato: "00000000000",
    valor_celular: 123.5,
    cep: "00000000",
    partnerCode: "synthetic-test-partner",
    salesChannel: "synthetic-test-channel",
    proposalId: "synthetic-test-proposal",
    sessionId: "synthetic-test-session",
  });
  assert.deepEqual(result.summary, {
    providerDecision: null,
    motivos: ["ENRICHMENT_OFF"],
  });
});

test("TechTrail mock preserva decisões determinísticas para CPF par e ímpar", async () => {
  let fetchCalls = 0;
  const fetchStub = async () => {
    fetchCalls += 1;
    throw new Error("UNEXPECTED_FETCH");
  };

  await withIsolatedEnvironmentAsync(
    { ENRICHMENT_MODE: "mock", ENRICHMENT_MOCK_MS: "0" },
    () =>
      withFetchStub(fetchStub, async () => {
        const even = await techTrailEnrichmentProvider.enrich(
          normalizedEnrichmentInput({ cpf: "00000000000" })
        );
        const odd = await techTrailEnrichmentProvider.enrich(
          normalizedEnrichmentInput({ cpf: "00000000001" })
        );

        assert.equal(even.httpStatus, 200);
        assert.equal(even.summary.providerDecision, "ACEITO");
        assert.deepEqual(even.summary.motivos, ["MOCK_OK"]);
        assert.equal(odd.summary.providerDecision, "DECLINADO");
        assert.deepEqual(odd.summary.motivos, ["MOCK_DECLINED"]);
      })
  );

  assert.equal(fetchCalls, 0);
});

test("TechTrail real preserva request e normalização do retorno", async () => {
  const calls = [];
  const providerPayload = {
    decisao: "ACEITO",
    motivos: ["SYNTHETIC_PROVIDER_REASON", 7, ""],
    riscoCredito: " ALTO ",
    probabilidadePagamento: " MEDIA ",
    quantidadeProcessos: "4",
    mandadoPrisao: "1",
    pessoaExpostaPoliticamente: " NAO ",
    percentualAssertividadeNome: "88.5",
    situacaoCpf: " REGULAR ",
  };

  const result = await runRealEnrichment(
    async (url, init) => {
      calls.push({ url, init });
      return textResponse(200, JSON.stringify(providerPayload));
    },
    () =>
      techTrailEnrichmentProvider.enrich(normalizedEnrichmentInput())
  );

  assert.equal(calls.length, 1);
  const requestedUrl = new URL(calls[0].url);
  assert.equal(
    `${requestedUrl.origin}${requestedUrl.pathname}`,
    "https://techtrail.example.invalid/pf"
  );
  assert.deepEqual([...requestedUrl.searchParams.entries()], [
    ["cpf", "00000000000"],
    ["nome", "PESSOA SINTETICA"],
    ["email", "provider-test@example.invalid"],
    ["telefone_contato", "00000000000"],
    ["valor_celular", "123.5"],
    ["cep", "00000000"],
  ]);
  assert.equal(requestedUrl.searchParams.has("partnerCode"), false);
  assert.equal(requestedUrl.searchParams.has("salesChannel"), false);
  assert.equal(requestedUrl.searchParams.has("proposalId"), false);
  assert.equal(requestedUrl.searchParams.has("sessionId"), false);
  assert.equal(requestedUrl.searchParams.has("traceId"), false);
  assert.deepEqual(calls[0].init.headers, {
    Authorization: "synthetic-test-auth",
    Accept: "application/json",
  });
  assert.equal(calls[0].init.method, "GET");
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  assert.equal(result.ok, true);
  assert.equal(result.mode, "real");
  assert.equal(result.provider, "techtrail");
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.raw, providerPayload);
  assert.deepEqual(result.summary, {
    providerDecision: "ACEITO",
    motivos: ["SYNTHETIC_PROVIDER_REASON", "7"],
    riscoCredito: "ALTO",
    probabilidadePagamento: "MEDIA",
    quantidadeProcessos: 4,
    mandadoPrisao: true,
    pessoaExpostaPoliticamente: "NAO",
    percentualAssertividadeNome: 88.5,
    situacaoCpf: "REGULAR",
  });
});

test("TechTrail real preserva erro HTTP", async () => {
  const body = { error: "synthetic-provider-down" };
  const result = await runRealEnrichment(
    async () => textResponse(503, JSON.stringify(body)),
    () => techTrailEnrichmentProvider.enrich(normalizedEnrichmentInput())
  );

  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 503);
  assert.deepEqual(result.raw, body);
  assert.deepEqual(result.error, {
    msg: "TECHTRAIL_HTTP_ERROR",
    code: "503",
    detail: body,
  });
});

test("TechTrail real preserva falha para JSON inválido em resposta 200", async () => {
  const result = await runRealEnrichment(
    async () => textResponse(200, "synthetic-non-json"),
    () => techTrailEnrichmentProvider.enrich(normalizedEnrichmentInput())
  );

  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.raw, { nonJson: "synthetic-non-json" });
  assert.deepEqual(result.error, {
    msg: "TECHTRAIL_INVALID_JSON",
    detail: "synthetic-non-json",
  });
});

test("TechTrail real preserva timeout via AbortController", async () => {
  let aborted = false;
  const result = await withIsolatedEnvironmentAsync(
    { ...REAL_ENRICHMENT_ENV, ENRICHMENT_TIMEOUT_MS: "2" },
    () =>
      withFetchStub(async (_url, init) => {
        init.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true }
        );
        return abortingFetch()(_url, init);
      }, () =>
        techTrailEnrichmentProvider.enrich(normalizedEnrichmentInput())
      )
  );

  assert.equal(aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, null);
  assert.equal(result.raw, null);
  assert.equal(result.error.msg, "TECHTRAIL_TIMEOUT");
});

test("IMEI inválido por Luhn é rejeitado antes do fetch", async () => {
  let fetchCalls = 0;
  const result = await runImeiCheck(
    {
      imeiCode: SYNTHETIC_INVALID_IMEI,
      modeloDeclarado: "Apple iPhone Synthetic Test",
      timeoutMs: 50,
    },
    async () => {
      fetchCalls += 1;
      throw new Error("UNEXPECTED_FETCH");
    }
  );

  assert.equal(fetchCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "IMEI_INVALID");
  assert.equal(result.brandExpected, "APPLE");
  assert.equal(result.serviceId, null);
  assert.equal(result.raw, null);
});

test("IMEI Samsung preserva Luhn, limpeza, service ID e parsing", async () => {
  const calls = [];
  const rawResult = {
    manufacturer: "Samsung",
    full_name: "Samsung Galaxy Synthetic",
    model_name: "Galaxy Synthetic",
    model_number: "SM-SYNTHETIC",
    serial_number: "synthetic-test-samsung-serial",
    imei1: SYNTHETIC_VALID_IMEI,
    warranty_status: "SYNTHETIC_WARRANTY",
    sold_by_country: "ZZ",
    carrier: "SYNTHETIC_CARRIER",
    knox_guard: "SYNTHETIC_CLEAR",
  };
  const raw = { status: "Successful", result: rawResult };

  const result = await runImeiCheck(
    {
      imeiCode: SYNTHETIC_FORMATTED_IMEI,
      modeloDeclarado: "Samsung Galaxy Synthetic Test",
      timeoutMs: 50,
    },
    async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, raw);
    }
  );

  assert.equal(calls.length, 1);
  assertImeiRequest(calls[0], 76);
  assert.equal(result.ok, true);
  assert.equal(result.reason, "IMEI_OK");
  assert.equal(result.brandExpected, "SAMSUNG");
  assert.equal(result.brandReturned, "SAMSUNG");
  assert.equal(result.serviceId, 76);
  assert.deepEqual(result.summary, {
    brand: "SAMSUNG",
    model_name: "Galaxy Synthetic",
    model_code: "SM-SYNTHETIC",
    serial_number: "synthetic-test-samsung-serial",
    imei_checked: SYNTHETIC_VALID_IMEI,
    warranty_status: "SYNTHETIC_WARRANTY",
    purchase_country: "ZZ",
    activation_status: null,
    carrier_status: "SYNTHETIC_CARRIER",
    lock_status: null,
    anti_theft_status: "SYNTHETIC_CLEAR",
  });
  assert.deepEqual(result.raw, raw);
});

test("IMEI Apple preserva service ID e parsing", async () => {
  const calls = [];
  const rawResult = {
    manufacturer: "Apple",
    full_name: "Apple iPhone Synthetic",
    model_name: "iPhone Synthetic",
    model_details: "SYNTHETIC-APPLE-CODE",
    serial_number: "synthetic-test-apple-serial",
    imei_number: SYNTHETIC_VALID_IMEI,
    warranty_status: "SYNTHETIC_WARRANTY",
    purchase_country: "ZZ",
    activation_status: "SYNTHETIC_ACTIVE",
    sim_lock_status: "SYNTHETIC_SIM_STATUS",
    locked_carrier: "SYNTHETIC_FALLBACK_CARRIER",
    device_is_unlocked: false,
    icloud_lock: "SYNTHETIC_CLEAR",
  };

  const result = await runImeiCheck(
    {
      imeiCode: SYNTHETIC_VALID_IMEI,
      modeloDeclarado: "Apple iPhone Synthetic Test",
      timeoutMs: 50,
    },
    async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { status: "Successful", result: rawResult });
    }
  );

  assertImeiRequest(calls[0], 19);
  assert.equal(result.reason, "IMEI_OK");
  assert.equal(result.brandExpected, "APPLE");
  assert.equal(result.brandReturned, "APPLE");
  assert.equal(result.serviceId, 19);
  assert.deepEqual(result.summary, {
    brand: "APPLE",
    model_name: "iPhone Synthetic",
    model_code: "SYNTHETIC-APPLE-CODE",
    serial_number: "synthetic-test-apple-serial",
    imei_checked: SYNTHETIC_VALID_IMEI,
    warranty_status: "SYNTHETIC_WARRANTY",
    purchase_country: "ZZ",
    activation_status: "SYNTHETIC_ACTIVE",
    carrier_status: "SYNTHETIC_SIM_STATUS",
    lock_status: "LOCKED",
    anti_theft_status: "SYNTHETIC_CLEAR",
  });
});

test("IMEI Xiaomi preserva service ID e parsing", async () => {
  const calls = [];
  const rawResult = {
    "Model Name": "Redmi Synthetic",
    "Model Code": "SYNTHETIC-XIAOMI-CODE",
    "Serial Number": "synthetic-test-xiaomi-serial",
    "IMEI Number": SYNTHETIC_VALID_IMEI,
    "Warranty Status": "SYNTHETIC_WARRANTY",
    "Purchase Country": "ZZ",
    "Activation Date": "SYNTHETIC_DATE",
    "MI Activation Lock": "SYNTHETIC_CLEAR",
  };

  const result = await runImeiCheck(
    {
      imeiCode: SYNTHETIC_VALID_IMEI,
      modeloDeclarado: "Xiaomi Poco Synthetic Test",
      timeoutMs: 50,
    },
    async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { status: "Successful", result: rawResult });
    }
  );

  assertImeiRequest(calls[0], 84);
  assert.equal(result.reason, "IMEI_OK");
  assert.equal(result.brandExpected, "XIAOMI");
  assert.equal(result.brandReturned, "XIAOMI");
  assert.equal(result.serviceId, 84);
  assert.deepEqual(result.summary, {
    brand: "XIAOMI",
    model_name: "Redmi Synthetic",
    model_code: "SYNTHETIC-XIAOMI-CODE",
    serial_number: "synthetic-test-xiaomi-serial",
    imei_checked: SYNTHETIC_VALID_IMEI,
    warranty_status: "SYNTHETIC_WARRANTY",
    purchase_country: "ZZ",
    activation_status: "SYNTHETIC_DATE",
    carrier_status: null,
    lock_status: null,
    anti_theft_status: "SYNTHETIC_CLEAR",
  });
});

test("IMEI de marca desconhecida falha sem service ID e sem fetch", async () => {
  let fetchCalls = 0;
  const result = await runImeiCheck(
    {
      imeiCode: SYNTHETIC_VALID_IMEI,
      modeloDeclarado: "Synthetic Test Device",
      timeoutMs: 50,
    },
    async () => {
      fetchCalls += 1;
      throw new Error("UNEXPECTED_FETCH");
    }
  );

  assert.equal(fetchCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "IMEI_FAIL");
  assert.equal(result.brandExpected, "UNKNOWN");
  assert.equal(result.serviceId, null);
  assert.deepEqual(result.raw, {
    error: "MISSING_SERVICE_ID_FOR_BRAND",
  });
});

test("IMEI preserva erro HTTP do IMEI.info", async () => {
  const raw = { error: "synthetic-provider-down" };
  const result = await runImeiCheck(
    {
      imeiCode: SYNTHETIC_VALID_IMEI,
      modeloDeclarado: "Samsung Galaxy Synthetic Test",
      timeoutMs: 50,
    },
    async () => jsonResponse(503, raw)
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "IMEI_FAIL");
  assert.equal(result.httpStatus, 503);
  assert.equal(result.brandExpected, "SAMSUNG");
  assert.equal(result.serviceId, 76);
  assert.deepEqual(result.raw, raw);
});

test("IMEI preserva rejeição do provider como IMEI_INVALID", async () => {
  const raw = { status: "Rejected", result: "synthetic-rejection" };
  const result = await runImeiCheck(
    {
      imeiCode: SYNTHETIC_VALID_IMEI,
      modeloDeclarado: "Apple iPhone Synthetic Test",
      timeoutMs: 50,
    },
    async () => jsonResponse(200, raw)
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "IMEI_INVALID");
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.raw, raw);
});

test("IMEI preserva divergência entre marca declarada e retornada", async () => {
  const result = await runImeiCheck(
    {
      imeiCode: SYNTHETIC_VALID_IMEI,
      modeloDeclarado: "Samsung Galaxy Synthetic Test",
      timeoutMs: 50,
    },
    async () =>
      jsonResponse(200, {
        status: "Successful",
        result: {
          manufacturer: "Apple",
          model_name: "iPhone Synthetic",
        },
      })
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "IMEI_BRAND_MISMATCH");
  assert.equal(result.brandExpected, "SAMSUNG");
  assert.equal(result.brandReturned, "APPLE");
  assert.equal(result.serviceId, 76);
  assert.equal(result.summary.brand, "APPLE");
});

test("IMEI preserva timeout como IMEI_FAIL", async () => {
  let aborted = false;
  const result = await runImeiCheck(
    {
      imeiCode: SYNTHETIC_VALID_IMEI,
      modeloDeclarado: "Samsung Galaxy Synthetic Test",
      timeoutMs: 2,
    },
    async (_url, init) => {
      init.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true }
      );
      return abortingFetch()(_url, init);
    }
  );

  assert.equal(aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.reason, "IMEI_FAIL");
  assert.equal(result.serviceId, 76);
  assert.equal(result.raw.errorName, "AbortError");
});

test("IMEI preserva resposta 200 sem JSON como IMEI_OK", async () => {
  const result = await runImeiCheck(
    {
      imeiCode: SYNTHETIC_VALID_IMEI,
      modeloDeclarado: "Samsung Galaxy Synthetic Test",
      timeoutMs: 50,
    },
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("synthetic-invalid-json");
      },
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "IMEI_OK");
  assert.equal(result.brandExpected, "SAMSUNG");
  assert.equal(result.brandReturned, null);
  assert.equal(result.summary, null);
  assert.equal(result.raw, null);
});

test("TechTrail mode normalizes case/space and typos never trigger a real fetch", async () => {
  let fetchCalls = 0;
  const fetchStub = async () => {
    fetchCalls += 1;
    throw new Error("UNEXPECTED_FETCH");
  };
  const input = normalizedEnrichmentInput();

  const mockResult = await withIsolatedEnvironmentAsync(
    { ENRICHMENT_MODE: " MOCK ", ENRICHMENT_MOCK_MS: "0" },
    () => withFetchStub(fetchStub, () => techTrailEnrichmentProvider.enrich(input))
  );
  assert.equal(mockResult.mode, "mock");

  for (const invalid of ["rea", "reall", "prod", "true"]) {
    await assert.rejects(
      withIsolatedEnvironmentAsync(
        { ENRICHMENT_MODE: invalid },
        () => withFetchStub(fetchStub, () => techTrailEnrichmentProvider.enrich(input))
      ),
      /ENRICHMENT_MODE/
    );
  }
  assert.equal(fetchCalls, 0);
});
