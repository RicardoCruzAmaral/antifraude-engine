const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadProviderAdaptersForCharacterization,
  withIsolatedEnvironmentAsync,
} = require("../helpers/analyze-characterization-harness.cjs");

const loaded = loadProviderAdaptersForCharacterization();
const { createImeiBlacklistProvider, resolveBlacklistServiceId } = loaded.imeiBlacklist;
const { classifyBlacklistStatus, normalizeBlacklistFields } = loaded.imeiBlacklistCore;
const IMEI = "490154203237518";

function response(result, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() {
      if (options.jsonThrows) throw options.jsonThrows;
      return options.directJson ?? { status: "Successful", result };
    },
  };
}

function cleanResult(overrides = {}) {
  return {
    model: "Galaxy S20 FE LTE",
    model_name: "SM-G780G/DS",
    manufacturer: "Samsung Korea",
    imei_number: IMEI,
    blacklist_status: "Clean",
    general_list_status: "No",
    blacklist_records: 0,
    device_is_clean: true,
    created_at: "2026-08-28T20:18:00Z",
    ...overrides,
  };
}

function blacklistedResult(overrides = {}) {
  return {
    imei_number: IMEI,
    blacklist_status: "Blacklisted",
    general_list_status: "Yes",
    blacklist_records: 1,
    device_is_clean: false,
    ...overrides,
  };
}

test("service ID Blacklist não possui default e aceita somente inteiro positivo", () => {
  assert.equal(resolveBlacklistServiceId(undefined), null);
  assert.equal(resolveBlacklistServiceId(""), null);
  assert.equal(resolveBlacklistServiceId("0"), null);
  assert.equal(resolveBlacklistServiceId("1.5"), null);
  assert.equal(resolveBlacklistServiceId("1e3"), null);
  assert.equal(resolveBlacklistServiceId("0x10"), null);
  assert.equal(resolveBlacklistServiceId("+7"), null);
  assert.equal(resolveBlacklistServiceId("9007199254740992"), null);
  assert.equal(resolveBlacklistServiceId("not-an-id"), null);
  assert.equal(resolveBlacklistServiceId("777"), 777);
});

test("normalização CLEAN exige quarteto explícito coerente", () => {
  const booleanTrue = normalizeBlacklistFields({
    blacklist_status: "Clean", general_list_status: "No",
    blacklist_records: 0, device_is_clean: true,
  });
  const stringTrue = normalizeBlacklistFields({
    blacklist_status: "Clean", general_list_status: "No",
    blacklist_records: 0, device_is_clean: "true",
  });
  const booleanFalse = normalizeBlacklistFields({
    blacklist_status: "Clean", general_list_status: "No",
    blacklist_records: 0, device_is_clean: false,
  });
  const stringFalse = normalizeBlacklistFields({
    blacklist_status: "Clean", general_list_status: "No",
    blacklist_records: 0, device_is_clean: "false",
  });
  assert.equal(classifyBlacklistStatus(booleanTrue), "CLEAN");
  assert.equal(classifyBlacklistStatus(stringTrue), "CLEAN");
  assert.equal(classifyBlacklistStatus(booleanFalse), "UNKNOWN");
  assert.equal(classifyBlacklistStatus(stringFalse), "UNKNOWN");
  assert.equal(classifyBlacklistStatus(normalizeBlacklistFields({ device_is_clean: false })), "UNKNOWN");
  assert.equal(classifyBlacklistStatus({ ...booleanTrue, generalListStatus: null }), "UNKNOWN");
});

test("BLACKLISTED exige sinal explícito sem contradição", () => {
  const blacklisted = normalizeBlacklistFields({
    blacklist_status: "Blacklisted", general_list_status: "Yes",
    blacklist_records: 2, device_is_clean: false,
  });
  assert.equal(classifyBlacklistStatus(blacklisted), "BLACKLISTED");
  assert.equal(classifyBlacklistStatus(normalizeBlacklistFields({
    blacklist_status: "Blacklisted", device_is_clean: false,
  })), "BLACKLISTED");
  assert.equal(classifyBlacklistStatus({ ...blacklisted, deviceIsClean: true }), "UNKNOWN");
  assert.equal(classifyBlacklistStatus({ ...blacklisted, blacklistStatusRaw: "Not Blacklisted", blacklistRecords: null, deviceIsClean: null, generalListStatus: null }), "UNKNOWN");
});

test("device_is_clean aceita apenas boolean ou strings true/false conservadoras", () => {
  for (const [input, expected] of [
    [true, true], [false, false], ["true", true], ["false", false],
    [" TRUE ", true], [" False ", false],
  ]) {
    assert.equal(normalizeBlacklistFields({ device_is_clean: input }).deviceIsClean, expected);
  }
  for (const input of ["yes", "no", "1", "0", 1, 0, "clean", "unknown", "", null, undefined, {}, []]) {
    assert.equal(normalizeBlacklistFields({ device_is_clean: input }).deviceIsClean, null);
  }
});

test("campos numéricos não sofrem coerção insegura", () => {
  assert.equal(normalizeBlacklistFields({ blacklist_records: "2" }).blacklistRecords, 2);
  assert.equal(normalizeBlacklistFields({ blacklist_records: "2.0" }).blacklistRecords, null);
  assert.equal(normalizeBlacklistFields({ blacklist_records: true }).blacklistRecords, null);
});

test("configuração ou API key ausente retorna UNAVAILABLE sem fetch", async () => {
  await withIsolatedEnvironmentAsync({}, async () => {
    let fetches = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => { fetches += 1; throw new Error("unexpected"); };
    try {
      assert.equal((await createImeiBlacklistProvider(null).check({ imeiCode: IMEI, timeoutMs: 10 })).status, "UNAVAILABLE");
      assert.equal((await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 10 })).status, "UNAVAILABLE");
      assert.equal(fetches, 0);
    } finally { global.fetch = originalFetch; }
  });
});

test("API key somente com espaços não provoca chamada", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "   " }, async () => {
    let fetches = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => { fetches += 1; throw new Error("unexpected"); };
    try {
      const result = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 10 });
      assert.equal(result.status, "UNAVAILABLE");
      assert.equal(fetches, 0);
    } finally { global.fetch = originalFetch; }
  });
});

test("IMEI localmente inválido retorna INVALID sem chamada paga", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    let fetches = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => { fetches += 1; throw new Error("unexpected"); };
    try {
      const result = await createImeiBlacklistProvider(777).check({ imeiCode: "123", timeoutMs: 10 });
      assert.equal(result.status, "INVALID");
      assert.equal(fetches, 0);
    } finally { global.fetch = originalFetch; }
  });
});

test("provider usa somente serviço Blacklist configurado e ignora modelo declarado", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const urls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      urls.push(String(url));
      return response({
        imei_number: IMEI, blacklist_status: "Clean", general_list_status: "No",
        blacklist_records: 0, device_is_clean: true,
      });
    };
    try {
      const provider = createImeiBlacklistProvider(777);
      for (const modeloDeclarado of ["iPhone", "Galaxy", "Motorola", "Xiaomi"]) {
        const result = await provider.check({ imeiCode: IMEI, timeoutMs: 20, modeloDeclarado });
        assert.equal(result.status, "CLEAN");
        assert.equal(result.service, "blacklist:777");
      }
      assert.equal(urls.length, 4);
      for (const url of urls) assert.equal(new URL(url).pathname, "/api-sync/check/777");
    } finally { global.fetch = originalFetch; }
  });
});

test("resposta conhecida é normalizada no contrato factual suportado", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => response(null, {
      directJson: { id: 211907431, status: "Done", result: cleanResult({
        device_is_clean: "true",
        created_at: "2026-08-28 21:22 UTC",
      }) },
    });
    try {
      const result = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 20 });
      assert.deepEqual({
        status: result.status, model: result.model, modelName: result.modelName,
        manufacturer: result.manufacturer, blacklistStatusRaw: result.blacklistStatusRaw,
        generalListStatus: result.generalListStatus, blacklistRecords: result.blacklistRecords,
        deviceIsClean: result.deviceIsClean, providerCreatedAt: result.providerCreatedAt,
      }, {
        status: "CLEAN", model: "Galaxy S20 FE LTE", modelName: "SM-G780G/DS", manufacturer: "Samsung Korea",
        blacklistStatusRaw: "Clean", generalListStatus: "No", blacklistRecords: 0,
        deviceIsClean: true, providerCreatedAt: "2026-08-28 21:22 UTC",
      });
      assert.equal(result.rawReference, "imei-info-search:211907431");
    } finally { global.fetch = originalFetch; }
  });
});

test("resposta final imediata Done BLACKLISTED mantém evidência explícita", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => response(null, {
      directJson: { id: 211894176, status: "Done", result: blacklistedResult() },
    });
    try {
      const result = await createImeiBlacklistProvider(28).check({ imeiCode: IMEI, timeoutMs: 20 });
      assert.equal(result.status, "BLACKLISTED");
      assert.equal(result.technicalReason, null);
      assert.equal(result.rawReference, "imei-info-search:211894176");
    } finally { global.fetch = originalFetch; }
  });
});

test("202 accepted e In_progress fazem polling do mesmo ID até CLEAN", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const calls = [];
    const queue = [
      response(null, { status: 202, directJson: { message: "Accepted", history_id: 211894175, ulid: "01SYNTHETICULID000000000000" } }),
      response(null, { directJson: { id: 211894175, status: "In_progress", result: null } }),
      response(null, { directJson: { id: 211894175, status: "Done", result: cleanResult() } }),
    ];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      return queue.shift();
    };
    try {
      const result = await createImeiBlacklistProvider(28).check({ imeiCode: IMEI, timeoutMs: 1000 });
      assert.equal(result.status, "CLEAN");
      assert.equal(result.rawReference, "imei-info-search:211894175");
      assert.equal(calls.length, 3);
      assert.equal(calls.filter((call) => call.url.pathname === "/api-sync/check/28").length, 1);
      assert.deepEqual(calls.slice(1).map((call) => call.url.pathname), [
        "/api/search_history/211894175/",
        "/api/search_history/211894175/",
      ]);
      assert.equal(calls[0].url.searchParams.get("imei"), IMEI);
      assert.equal(calls[1].url.searchParams.has("imei"), false);
      assert.ok(calls.every((call) => call.options.signal instanceof AbortSignal));
    } finally { global.fetch = originalFetch; }
  });
});

test("Processing faz polling e finaliza BLACKLISTED sem nova submissão", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const paths = [];
    const queue = [
      response(null, { directJson: { id: "01SYNTHETICSEARCHID000000001", status: "Processing", result: null } }),
      response(null, { directJson: { id: "01SYNTHETICSEARCHID000000001", status: "Done", result: blacklistedResult() } }),
    ];
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      paths.push(new URL(String(url)).pathname);
      return queue.shift();
    };
    try {
      const result = await createImeiBlacklistProvider(28).check({ imeiCode: IMEI, timeoutMs: 700 });
      assert.equal(result.status, "BLACKLISTED");
      assert.equal(paths.filter((path) => path === "/api-sync/check/28").length, 1);
      assert.deepEqual(paths.slice(1), ["/api/search_history/01SYNTHETICSEARCHID000000001/"]);
    } finally { global.fetch = originalFetch; }
  });
});

test("In_progress até o deadline retorna PENDING_TIMEOUT sem resubmeter", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const paths = [];
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      paths.push(pathname);
      return response(null, { directJson: { id: 211894177, status: "In_progress", result: null } });
    };
    try {
      const result = await createImeiBlacklistProvider(28).check({ imeiCode: IMEI, timeoutMs: 275 });
      assert.equal(result.status, "UNAVAILABLE");
      assert.equal(result.technicalReason, "PENDING_TIMEOUT");
      assert.equal(result.rawReference, "imei-info-search:211894177");
      assert.equal(paths.filter((path) => path === "/api-sync/check/28").length, 1);
      assert.ok(paths.some((path) => path === "/api/search_history/211894177/"));
    } finally { global.fetch = originalFetch; }
  });
});

for (const [label, fetchFactory, expectedReason] of [
  ["HTTP error", async () => response(null, { ok: false, status: 503 }), "HTTP_ERROR"],
  ["JSON inválido", async () => response(null, { jsonThrows: new Error("json") }), "INVALID_JSON"],
  ["exception", async () => { throw new Error("network"); }, "REQUEST_FAILED"],
]) {
  test(`${label} é UNAVAILABLE, não fraude`, async () => {
    await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
      const originalFetch = global.fetch;
      global.fetch = fetchFactory;
      try {
        const result = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 20 });
        assert.equal(result.status, "UNAVAILABLE");
        assert.equal(result.technicalReason, expectedReason);
      } finally { global.fetch = originalFetch; }
    });
  });
}

test("timeout é UNAVAILABLE", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const originalFetch = global.fetch;
    global.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    try {
      const result = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 1 });
      assert.equal(result.status, "UNAVAILABLE");
      assert.equal(result.technicalReason, "TIMEOUT");
    } finally { global.fetch = originalFetch; }
  });
});

test("AbortError durante leitura do JSON continua sendo TIMEOUT", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true, status: 200,
      async json() { throw Object.assign(new Error("aborted-body"), { name: "AbortError" }); },
    });
    try {
      const result = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 20 });
      assert.equal(result.status, "UNAVAILABLE");
      assert.equal(result.technicalReason, "TIMEOUT");
    } finally { global.fetch = originalFetch; }
  });
});

test("rejeição genérica é técnica; somente Invalid IMEI explícito é INVALID", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const originalFetch = global.fetch;
    try {
      global.fetch = async () => response(null, { directJson: { status: "Rejected", result: null } });
      const generic = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 20 });
      assert.equal(generic.status, "UNAVAILABLE");
      assert.equal(generic.technicalReason, "PROVIDER_REJECTED");
      global.fetch = async () => response({
        imei_number: IMEI, blacklist_status: "Clean", general_list_status: "No",
        blacklist_records: 0, device_is_clean: true,
      }, { directJson: { status: "Rejected", result: {
        imei_number: IMEI, blacklist_status: "Clean", general_list_status: "No",
        blacklist_records: 0, device_is_clean: true,
      } } });
      const rejectedObject = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 20 });
      assert.equal(rejectedObject.status, "UNAVAILABLE");
      global.fetch = async () => response(null, { directJson: { status: "Rejected", result: "Invalid IMEI" } });
      const invalid = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 20 });
      assert.equal(invalid.status, "INVALID");
    } finally { global.fetch = originalFetch; }
  });
});

test("IMEI retornado presente porém malformado é UNAVAILABLE", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => response({
      imei_number: "not-an-imei", blacklist_status: "Clean",
      general_list_status: "No", blacklist_records: 0, device_is_clean: true,
    });
    try {
      const result = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 20 });
      assert.equal(result.status, "UNAVAILABLE");
      assert.equal(result.technicalReason, "RETURNED_IMEI_MISMATCH");
    } finally { global.fetch = originalFetch; }
  });
});

test("IMEI retornado divergente é UNAVAILABLE", async () => {
  await withIsolatedEnvironmentAsync({ IMEI_INFO_API_KEY: "synthetic-key" }, async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => response({
      imei_number: "490154203237526", blacklist_status: "Clean",
      general_list_status: "No", blacklist_records: 0, device_is_clean: true,
    });
    try {
      const result = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 20 });
      assert.equal(result.status, "UNAVAILABLE");
      assert.equal(result.technicalReason, "RETURNED_IMEI_MISMATCH");
    } finally { global.fetch = originalFetch; }
  });
});
