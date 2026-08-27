// post-test.mjs
import "dotenv/config";

const analyzeUrl = process.env.ANALYZE_URL || "http://localhost:3000/api/analyze";

const payload = {
  cpf: "00000000000",
  nome: "PESSOA SINTETICA DE TESTE",
  email: "manual-test@example.invalid",
  telefone_contato: "00000000000",
  cep: "00000000",
  valor_celular: 3500,

  partnerCode: "synthetic-test-partner",
  salesChannel: "synthetic-test-channel",
  proposalId: "synthetic-test-proposal-0001",
  sessionId: "synthetic-test-session-0001",

  modelo_declarado: "SYNTHETIC TEST DEVICE",

  // IMEI sintético reservado exclusivamente para teste manual
  imeiCode: "000000000000000",

  // Fingerprint integralmente sintético
  device: {
    fingerprintProvider: "synthetic-test-provider",
    visitorId: "synthetic-test-visitor-0001",
    requestId: "synthetic-test-request-0001",
    confidenceScore: 1,
    confidenceRevision: "synthetic-test-v1",
    os: "SyntheticOS",
    osVersion: "1.0",
    browserName: "SyntheticBrowser",
    browserVersion: "1.0",
    isMobile: true,
    screenWidth: 360,
    screenHeight: 800,
    screenDPR: 3,
    screenWidthPhysical: 1080,
    screenHeightPhysical: 2400,
    gpu: "Synthetic Test GPU",
    cores: 8,
    timezone: "Etc/UTC",
    languages: ["en"],
    connectionType: "synthetic-test-network",
    incognito: false,
    ip: "192.0.2.10",
    rawUserAgent: "synthetic-test-user-agent/1.0",
    collectedAt: new Date().toISOString(),
  },
};

console.log("➡️ POST", analyzeUrl);
const res = await fetch(analyzeUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

console.log("HTTP", res.status);
console.log(await res.text());
