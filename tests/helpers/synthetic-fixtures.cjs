const SYNTHETIC_INPUT = Object.freeze({
  cpf: "00000000000",
  nome: "PESSOA SINTETICA DE TESTE",
  email: "characterization@example.invalid",
  telefone_contato: "00000000000",
  valor_celular: 0,
  cep: "00000000",
  modelo_declarado: "TEST DEVICE",
  partnerCode: "TEST_PARTNER",
  salesChannel: "TEST_CHANNEL",
  proposalId: "TEST_PROPOSAL_0001",
  sessionId: "TEST_SESSION_0001",
  device: {
    ip: "192.0.2.1",
    visitorId: "synthetic-test-visitor",
    os: "TestOS",
    isMobile: true,
    fingerprintProvider: "synthetic-test-provider",
  },
});

function enrichmentSummary(overrides = {}) {
  return {
    providerDecision: "ACEITO",
    motivos: [],
    riscoCredito: "BAIXISSIMO",
    probabilidadePagamento: "ALTISSIMA",
    quantidadeProcessos: 0,
    ...overrides,
  };
}

function enrichmentResult(summary) {
  return {
    ok: true,
    mode: "mock",
    provider: "mock",
    ms: 1,
    httpStatus: 200,
    requestParams: { cpf: SYNTHETIC_INPUT.cpf },
    raw: { fixture: "synthetic-characterization" },
    summary,
  };
}

function imeiResult(reason) {
  return {
    ok: reason === "IMEI_OK",
    provider: "imei_info",
    ms: 1,
    httpStatus: 200,
    reason,
    brandExpected: "UNKNOWN",
    brandReturned: null,
    serviceId: 999,
    summary: null,
    raw: { fixture: "synthetic-characterization" },
  };
}

module.exports = {
  SYNTHETIC_INPUT,
  enrichmentResult,
  enrichmentSummary,
  imeiResult,
};
