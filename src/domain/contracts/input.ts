export type DeviceFingerprintInput = {
  ip?: unknown;
  visitorId?: unknown;
  requestId?: unknown;
  os?: unknown;
  gpu?: unknown;
  cores?: unknown;
  isMobile?: unknown;
  osVersion?: unknown;
  browserName?: unknown;
  screenWidthPhysical?: unknown;
  screenHeightPhysical?: unknown;
  fingerprintProvider?: unknown;
  [key: string]: unknown;
};

export type InputSummary = {
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
  device: DeviceFingerprintInput | null;
};
