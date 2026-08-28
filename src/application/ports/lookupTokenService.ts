export interface LookupTokenService {
  tokenizeCpf(cpf: string): string;
  tokenizeImei(imei: string): string;
  hashRelevantInput(input: unknown): string;
}
