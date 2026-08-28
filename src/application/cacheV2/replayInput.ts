import type { InputSummary } from "../../domain/contracts";

export type ReplayInput = {
  cpf: string | null;
  nome: string | null;
  email: string | null;
  telefoneContato: string | null;
  cep: string | null;
  valorCelular: number | null;
  partnerCode: string | null;
  salesChannel: string | null;
  proposalId: string | null;
  modeloDeclarado: string | null;
  imeiCode: string | null;
  device: {
    ip: unknown;
    visitorId: unknown;
    os: unknown;
    gpu: unknown;
    cores: unknown;
    isMobile: unknown;
    osVersion: unknown;
    browserName: unknown;
    screenWidthPhysical: unknown;
    screenHeightPhysical: unknown;
    fingerprintProvider: unknown;
  } | null;
};

export function buildReplayInput(input: InputSummary): ReplayInput {
  return {
    cpf: input.cpf,
    nome: input.nome,
    email: input.email,
    telefoneContato: input.telefone_contato,
    cep: input.cep,
    valorCelular: input.valor_celular,
    partnerCode: input.partnerCode,
    salesChannel: input.salesChannel,
    proposalId: input.proposalId,
    modeloDeclarado: input.modelo_declarado,
    imeiCode: input.imeiCode,
    device: input.device
      ? {
          ip: input.device.ip ?? null,
          visitorId: input.device.visitorId ?? null,
          os: input.device.os ?? null,
          gpu: input.device.gpu ?? null,
          cores: input.device.cores ?? null,
          isMobile: input.device.isMobile ?? null,
          osVersion: input.device.osVersion ?? null,
          browserName: input.device.browserName ?? null,
          screenWidthPhysical: input.device.screenWidthPhysical ?? null,
          screenHeightPhysical: input.device.screenHeightPhysical ?? null,
          fingerprintProvider: input.device.fingerprintProvider ?? null,
        }
      : null,
  };
}
