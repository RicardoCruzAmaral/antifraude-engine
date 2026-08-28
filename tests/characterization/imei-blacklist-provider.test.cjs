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
  const fields = normalizeBlacklistFields({
    blacklist_status: "Clean", general_list_status: "No",
    blacklist_records: 0, device_is_clean: true,
  });
  assert.equal(classifyBlacklistStatus(fields), "CLEAN");
  assert.equal(classifyBlacklistStatus({ ...fields, generalListStatus: null }), "UNKNOWN");
  assert.equal(classifyBlacklistStatus({ ...fields, deviceIsClean: "true" }), "UNKNOWN");
});

test("BLACKLISTED exige sinal explícito sem contradição", () => {
  const blacklisted = normalizeBlacklistFields({
    blacklist_status: "Blacklisted", general_list_status: "Yes",
    blacklist_records: 2, device_is_clean: false,
  });
  assert.equal(classifyBlacklistStatus(blacklisted), "BLACKLISTED");
  assert.equal(classifyBlacklistStatus({ ...blacklisted, deviceIsClean: true }), "UNKNOWN");
  assert.equal(classifyBlacklistStatus({ ...blacklisted, blacklistStatusRaw: "Not Blacklisted", blacklistRecords: null, deviceIsClean: null, generalListStatus: null }), "UNKNOWN");
});

test("campos numéricos e booleanos não sofrem coerção insegura", () => {
  assert.equal(normalizeBlacklistFields({ blacklist_records: "2" }).blacklistRecords, 2);
  assert.equal(normalizeBlacklistFields({ blacklist_records: "2.0" }).blacklistRecords, null);
  assert.equal(normalizeBlacklistFields({ blacklist_records: true }).blacklistRecords, null);
  assert.equal(normalizeBlacklistFields({ device_is_clean: "false" }).deviceIsClean, null);
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
    global.fetch = async () => response({
      model: "A", model_name: "Phone A", manufacturer: "Maker", imei_number: IMEI,
      blacklist_status: "Clean", general_list_status: "No", blacklist_records: 0,
      device_is_clean: true, created_at: "2026-08-01T00:00:00Z",
    });
    try {
      const result = await createImeiBlacklistProvider(777).check({ imeiCode: IMEI, timeoutMs: 20 });
      assert.deepEqual({
        status: result.status, model: result.model, modelName: result.modelName,
        manufacturer: result.manufacturer, blacklistStatusRaw: result.blacklistStatusRaw,
        generalListStatus: result.generalListStatus, blacklistRecords: result.blacklistRecords,
        deviceIsClean: result.deviceIsClean, providerCreatedAt: result.providerCreatedAt,
      }, {
        status: "CLEAN", model: "A", modelName: "Phone A", manufacturer: "Maker",
        blacklistStatusRaw: "Clean", generalListStatus: "No", blacklistRecords: 0,
        deviceIsClean: true, providerCreatedAt: "2026-08-01T00:00:00Z",
      });
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
