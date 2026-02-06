// post-test.mjs
import "dotenv/config";

const analyzeUrl = process.env.ANALYZE_URL || "http://localhost:3000/api/analyze";

const payload = {
  cpf: "17034130752",
  nome: "Ricardo da Cruz Amaral",
  email: "ricardoamaral704@gmail.com",
  telefone_contato: "21959021655",
  cep: "22713169",
  valor_celular: 3500,

  partnerCode: "Simple2u",
  salesChannel: "FingerPrint Front",
  proposalId: "PCELL000123456789",
  sessionId: "1010101010",

  modelo_declarado: "Apple iPhone 15 Pro",

  // IMEI (já preparado para o motor)
  imei: "356938035643809",

  // Fingerprint (POC)
  device: {
    fingerprintProvider: "fingerprintjs_pro",
    visitorId: "ln6fFSG0DTHDsis1Z5KU",
    requestId: "1770238629167.Kz4cVC",
    confidenceScore: 1,
    confidenceRevision: "v1.1",
    os: "Android",
    osVersion: "10",
    browserName: "Chrome Mobile",
    browserVersion: "144.0.0",
    isMobile: true,
    screenWidth: 360,
    screenHeight: 800,
    screenDPR: 3,
    screenWidthPhysical: 1080,
    screenHeightPhysical: 2400,
    gpu: "Adreno (TM) 650",
    cores: 8,
    timezone: "America/Sao_Paulo",
    languages: ["pt-BR", "pt", "en-US", "en"],
    connectionType: "4g",
    incognito: false,
    ip: "179.218.35.235",
    rawUserAgent:
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36",
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
