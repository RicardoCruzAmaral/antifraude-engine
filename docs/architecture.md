# Arquitetura do motor antifraude

## Fluxo de análise

`api/analyze.ts` valida o método HTTP, cria o trace, resolve a configuração e compõe os adapters. O `AnalyzeAntifraudUseCase` normaliza a entrada, consulta o cache e, em caso de miss, executa enrichment, pré-avaliação, IMEI quando aplicável, avaliação final, cache e auditoria. O resultado retorna à API, que preserva o status e o body HTTP.

## Responsabilidades por camada

- `api`: adaptador HTTP/Vercel e composition root.
- `application`: orquestração do caso de uso e ports necessários pela aplicação.
- `domain`: contratos e regras puras de decisão, sem SDKs ou providers externos.
- `infrastructure`: implementação dos ports para TechTrail, IMEI.info e Supabase.

Os principais ports são `EnrichmentProvider`, `ImeiProvider`, `DecisionCache`, `DecisionAuditRepository` e `ProviderRawRepository`.

## Fonte única das regras

A fonte ativa das regras é `src/domain/engine`:

- hard blocks: `hardBlocks.ts`;
- scoring: `scoring.ts`;
- profiles: `profiles.ts`;
- sequência de pré-avaliação e finalização: `evaluation.ts`.

O motor possui somente as decisões `APPROVE` e `DECLINE`.

Os adapters TechTrail e IMEI.info ficam em `src/infrastructure/providers`. Cache, auditoria de decisão e respostas raw ficam em `src/infrastructure/persistence/supabase`, implementando os ports de `src/application/ports`.

## Débitos fora desta refatoração

- Cache V2: chave, versionamento, invalidação, concorrência e diferenciação de indisponibilidade versus miss.
- Revisão funcional de hard blocks, pesos, profiles e política de IMEI.
- Revisão da semântica e retenção dos registros de auditoria/raw.
- Observabilidade: nomes históricos dos events, timestamps, significado de sucesso da persistência e peculiaridade de `score_computed`.
- Estratégia explícita para indisponibilidade de providers e persistência.
- Segurança, privacidade, retenção e mascaramento de dados sensíveis.

## Cache V2 — SHADOW WRITE / EVIDENCE READS / ANALYSIS REPLAY

A fundação do Cache V2 existe em paralelo ao `decision_cache` V1. Quando `CACHE_V2_WRITE_ENABLED=true`, o composition root injeta writers shadow best-effort. As leituras TechTrail, IMEI e Analysis Replay são controladas independentemente por flags. Evidence HIT evita o respectivo provider e recalcula a decisão; Replay HIT reutiliza somente uma resposta da mesma análise. Com as flags desligadas, nenhuma dependência V2 é necessária. O `decision_cache` V1 continua ativo por default.

Os mecanismos planejados são independentes:

1. `analysis_replay`: idempotência da mesma análise, identificada por `proposalId` opcional, HMAC canônico dos inputs relevantes, `analysisPolicyVersion` e versão do schema do cache.
2. `techtrail_evidence_cache`: evidência normalizada da pessoa. Sua identidade usa token HMAC do CPF, provider e versões de contrato, normalização e schema.
3. `imei_evidence_cache`: evidência normalizada do aparelho. Sua identidade usa token HMAC do IMEI, provider, serviço/produto e versões.

### Decisão conhecida do TechTrail V1

O cache TechTrail representa a pessoa/CPF. Alterar `proposalId`, email, telefone, CEP, valor, produto, modelo declarado, IMEI, fingerprint, `visitorId` ou canal não invalida automaticamente a evidência durante seu TTL. Motivos eventualmente influenciados pelo contexto da primeira consulta também permanecem na evidência durante esse período. Essa limitação é consciente e deverá ser reavaliada com dados de produção.

TechTrail, IMEI e Replay possuem defaults iniciais independentes de 30 dias em `TECHTRAIL_CACHE_TTL_DAYS`, `IMEI_CACHE_TTL_DAYS` e `ANALYSIS_REPLAY_TTL_DAYS`. Cada família aceita override próprio.

Shadow writes aceitos:

- TechTrail: somente resposta `ok` com summary; identidade da pessoa pelo token HMAC do CPF.
- IMEI: fatos válidos equivalentes a `IMEI_OK`/`IMEI_INVALID` são persistidos; mismatch e marca esperada são contexto da proposta e são reaplicados na leitura. `IMEI_FAIL`, timeout e erros técnicos não são persistidos no V2.
- Replay: resposta concluída do engine ou cache V1, persistida com a política interna efetiva. A leitura ocorre somente quando `ANALYSIS_REPLAY_ENABLED=true`.

A telemetria shadow usa um sink interno separado. Ela não é adicionada aos `events` públicos do response, preservando o contrato HTTP e o golden master.

### Replay input deliberado

O hash canônico inclui: CPF, nome, email, telefone, CEP, valor, parceiro, canal, proposta, modelo declarado, IMEI e os campos de device atualmente devolvidos no snapshot público (`ip`, `visitorId`, OS, GPU, cores, mobilidade, versão do OS, browser, dimensões de tela e provider do fingerprint). Esses campos de device ainda não pontuam, mas entram porque alteram o response atual; omiti-los permitiria devolver um snapshot antigo para um payload diferente.

Ficam excluídos: `sessionId`, `collectedAt`, request IDs técnicos do fingerprint, timestamps de transporte, propriedades extras do device e a ordem das propriedades JSON. Esses campos não alteram hoje a decisão nem o snapshot público relevante. `analysisPolicyVersion` e `cacheSchemaVersion` não entram no input hash porque participam separadamente da identidade e compatibilidade do Replay.

### Raw e segurança

Os caches V2 armazenam somente a evidência normalizada necessária para reutilização e uma `rawReference` opcional. O payload original permanece nos repositories raw de auditoria.

CPF e IMEI nunca são chaves cruas nas tabelas V2: são tokenizados por HMAC-SHA-256 com `EVIDENCE_LOOKUP_HMAC_KEY`. O segredo deve ser separado das credenciais dos providers, nunca logado e rotacionado por procedimento compatível com invalidação/reindexação. As tabelas têm RLS habilitado e não concedem acesso direto a `anon` ou `authenticated`. Retenção e descarte ainda precisam de política formal.

### Flags

Os defaults preservam integralmente o V1:

- `ANALYSIS_REPLAY_ENABLED=false`;
- `CACHE_V2_WRITE_ENABLED=false` — quando `true`, habilita apenas shadow write;
- `CACHE_V2_READ_TECHTRAIL_ENABLED=false`;
- `CACHE_V2_READ_IMEI_ENABLED=false`;
- `DECISION_CACHE_V1_READ_ENABLED=true`.

`ANALYSIS_REPLAY_ENABLED` controla somente a leitura antecipada. Shadow write continua controlado exclusivamente por `CACHE_V2_WRITE_ENABLED`.

## Analysis Replay READ — AVAILABLE BEHIND FLAG

Replay significa **a mesma análise**, não uma decisão por CPF. `ANALYSIS_REPLAY_ENABLED=false` é o default. Quando a flag está ligada, a consulta ocorre depois da normalização/validação mínima da entrada e antes do `decision_cache` V1, dos caches de evidência, dos providers e do engine.

```text
Request
  → buildInputSummary/buildReplayInput
  → Analysis Replay
      ├─ HIT → statusCode e body originais; zero providers/engine
      └─ fallback → Decision Cache V1 quando aplicável
                    → TechTrail Cache/Provider
                    → Engine
                    → IMEI Cache/Provider quando aplicável
                    → Decision
                    → Replay shadow write
```

A identidade lógica é:

```text
proposalId opcional
+ HMAC-SHA-256 do buildReplayInput canônico
+ analysisPolicyVersion
+ cacheSchemaVersion
```

`proposalId` não é suficiente sozinho e também participa do input hash. Mesmo `proposalId` com qualquer input relevante diferente produz outra identidade e executa uma nova análise. CPF isolado, `proposalId` isolado e `ruleVersion` HTTP isolado nunca autorizam reutilização.

O identificador interno de comportamento possui atualmente dois valores:

- `score-v1|imei-legacy-v1`;
- `score-v1|imei-blacklist-v1`.

Ele é persistido fisicamente na coluna histórica `analysis_replay.rule_version`, evitando migration, mas sua semântica é exclusivamente `analysisPolicyVersion`. O `ruleVersion` público continua sendo o produzido por cada fluxo existente e não governa compatibilidade do Replay. Essa separação impede reutilização nos dois sentidos entre IMEI legado e IMEI Blacklist V1.

- `HIT` defensivamente válido e não expirado: devolve exatamente `statusCode` e `body` armazenados; não consulta V1, evidence caches ou providers; não executa engine, auditoria de nova decisão ou shadow rewrite.
- `MISS`, `EXPIRED`, `INCOMPATIBLE` e `BACKEND_ERROR`: executam o fluxo atual normalmente. Erros de hash, configuração, HMAC ou adapter também fazem bypass best-effort.
- HIT não altera `createdAt`/`expiresAt` e não implementa sliding expiration.
- `ANALYSIS_REPLAY_TTL_DAYS` possui default independente de 30 dias e aceita override positivo por ENV.

A telemetria de Replay é interna (`hit`, `miss`, `expired`, `incompatible`, `backend_error` e `bypass`) e não altera o body armazenado nem o contrato HTTP público.

## TechTrail Cache V2 READ — AVAILABLE BEHIND FLAG

`CACHE_V2_READ_TECHTRAIL_ENABLED=false` continua sendo o default. Quando habilitada, a leitura ocorre depois do cache de decisão V1 e antes da chamada TechTrail. `DECISION_CACHE_V1_READ_ENABLED` agora governa explicitamente apenas a leitura antecipada V1; seu default permanece `true` e as escritas V1 continuam ativas.

A identidade consultada é o token HMAC do CPF, provider e versões de contrato, normalizer e schema. Email, telefone, CEP, valor, proposta, aparelho, IMEI, fingerprint e canal não participam dessa identidade.

- `HIT` fresh, `COMPLETE` e compatível: evita a chamada paga TechTrail e usa `normalizedEvidence`; hard blocks, score, IMEI e decisão são recalculados.
- `MISS`, `EXPIRED`, `INCOMPATIBLE` ou `BACKEND_ERROR`: chama TechTrail exatamente uma vez, sem stale-while-revalidate.
- HMAC/config/adapter indisponível: bypass best-effort e chamada normal ao provider.

Um HIT não cria `enrichment_raw`, não renova `fetchedAt`/`expiresAt` e não dispara shadow write da mesma evidência. Provenance (`state`, source, fetched/expiry e `rawReference`) é acrescentada somente à cópia dos events persistida em `decision_log`; não aparece nos events do response. Para preservar a sequência pública histórica, o step legado `enrichment_raw_saved` continua presente no response mesmo no HIT, embora nenhuma inserção raw seja executada — débito semântico de observabilidade já conhecido.

## IMEI Cache V2 READ — AVAILABLE BEHIND FLAG

`CACHE_V2_READ_IMEI_ENABLED=false` é o default. Quando habilitada, a leitura ocorre somente depois da pré-avaliação e de qualquer hard block, e somente quando há `imeiCode`. A identidade é: token HMAC do IMEI normalizado + provider + serviço/produto atual + versões do contrato do provider, normalizer e schema. CPF, proposta, valor, dados de contato, fingerprint e modelo declarado não entram diretamente na chave; o serviço permanece porque identifica o produto factual consultado no provider atual.

- `HIT` fresh, `COMPLETE` e compatível: evita a chamada paga ao IMEI.info e reutiliza somente a evidência factual; score, reasons, profile e decisão são recalculados.
- `MISS`, `EXPIRED`, `INCOMPATIBLE` ou `BACKEND_ERROR`: chama o provider exatamente uma vez, sem stale-while-revalidate.
- HMAC/config/adapter indisponível: bypass best-effort e chamada normal ao provider.

A evidência factual não persiste `brandExpected` nem um `IMEI_BRAND_MISMATCH` contextual. Na leitura, a marca retornada é comparada novamente com `modelo_declarado` da proposta atual. O normalizer IMEI foi versionado como `imei-normalizer-v2`, invalidando automaticamente artefatos antigos que congelavam mismatch. A seleção do serviço real e a semântica do provider permanecem inalteradas.

Um HIT não cria `imei_raw`, não renova `fetchedAt`/`expiresAt` e não dispara shadow rewrite. Proveniência (source, artifact/reference, fetched/expiry, age, provider e service) fica somente na auditoria interna; o contrato HTTP público não muda. `IMEI_CACHE_TTL_DAYS` tem default independente de 30 dias e aceita override por ENV.

Analysis Replay, quando habilitado, acontece antes desta leitura de evidência.

## IMEI Blacklist V1 — AVAILABLE BEHIND FLAG

`IMEI_BLACKLIST_V1_ENABLED=false` é o default de desenvolvimento e preserva integralmente o provider IMEI legado, inclusive seleção de serviços por marca, brand mismatch e penalidades históricas. Quando a flag está ligada, o fluxo muda deliberadamente:

```text
TechTrail
  → hard blocks
  → score e profile base
  → somente B1/B2 com IMEI válido são elegíveis
  → IMEI Blacklist Cache V2
  → IMEI.info BLACKLIST em cache miss
  → CLEAN mantém score/profile/decisão
  → BLACKLISTED força DECLINE
  → UNKNOWN/UNAVAILABLE não são fraude
```

Perfis A e C, hard blocks e B1/B2 sem IMEI não consultam cache nem provider. A validação local mantém sanitização, 15 dígitos e Luhn antes de qualquer chamada paga. `IMEI_INVALID` preserva temporariamente a penalidade legada configurada; timeout, HTTP error, exception e indisponibilidade de configuração não recebem pontos.

O provider novo não recebe `modelo_declarado` e usa exclusivamente `IMEI_BLACKLIST_SERVICE_ID`. Não há ID default: ausente, vazio ou inválido resulta em `UNAVAILABLE`, zero chamada HTTP e decisão baseada somente na pessoa. Os serviços Apple, Samsung e Xiaomi e a inferência por marca continuam presentes exclusivamente no caminho LEGACY/ROLLBACK quando a flag está desligada.

### Contrato e normalização Blacklist

A evidência normalizada suporta somente: status, model, modelName, manufacturer, blacklistStatusRaw, generalListStatus, blacklistRecords, deviceIsClean e providerCreatedAt. IMEI cru, modelo declarado, marca esperada e brand mismatch não são persistidos em `normalized_evidence`.

- `CLEAN`: exige simultaneamente `blacklist_status=Clean`, `general_list_status=No`, `blacklist_records=0` e `device_is_clean=true`.
- `BLACKLISTED`: exige sinal explícito (`Blacklisted`/`Blacklist`, general list `Yes`, registros acima de zero ou `device_is_clean=false`) sem sinal limpo contraditório.
- `UNKNOWN`: resposta válida, porém incompleta, desconhecida ou contraditória.
- `UNAVAILABLE`: configuração/API key ausente, timeout, exception, HTTP não-2xx, JSON inválido, rejeição genérica ou IMEI retornado divergente.

Somente validação local inválida ou retorno explícito `Invalid IMEI` produz `IMEI_INVALID`; rejeições técnicas não são convertidas em fraude.

### Cache, versões e decisão

A identidade Blacklist é:

```text
HMAC(IMEI sanitizado)
+ provider imei_info
+ service blacklist:<IMEI_BLACKLIST_SERVICE_ID>
+ imei-info-blacklist-v1
+ imei-blacklist-normalizer-v1
+ cache-v2-schema-v1
```

As versões e o namespace de serviço impedem que evidências Apple/Samsung/Xiaomi sejam interpretadas como Blacklist. Cold miss é esperado. `CLEAN`, `BLACKLISTED` e `UNKNOWN` válidos podem ser cacheados por `IMEI_CACHE_TTL_DAYS`, default independente de 30 dias. `UNAVAILABLE` e falhas técnicas nunca são cacheadas. HIT não grava raw, não renova TTL e não faz shadow rewrite.

`BLACKLISTED` mantém score e profile base B1/B2, força `DECLINE` e acrescenta `IMEI_BLACKLISTED` aos reasons sem pontos artificiais. `CLEAN`, `UNKNOWN` e `UNAVAILABLE` preservam a decisão da pessoa.

Enquanto a política Blacklist está ligada, o `decision_cache` V1 por CPF é ignorado para leitura e escrita. Isso evita tanto pular uma consulta Blacklist por um APPROVE antigo quanto contaminar o rollback legado com uma decisão nova. A auditoria usa `score-v1+imei-blacklist-v1`; o caminho legado mantém `score-v1`.

Telemetria Blacklist é interna/audit-only e não é acrescentada aos events HTTP públicos. Analysis Replay, quando habilitado, acontece antes do caminho Blacklist e separa sua identidade pela `analysisPolicyVersion`.
