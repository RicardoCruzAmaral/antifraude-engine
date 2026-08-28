# Cache V2 — rollout em ambiente controlado

Este runbook prepara somente a infraestrutura Supabase do Cache V2. Não use o
projeto de produção nesta fase. Não configure providers reais nem execute
chamadas TechTrail/IMEI.info.

## Configuração segura inicial

```dotenv
ENRICHMENT_MODE=mock
CACHE_V2_WRITE_ENABLED=false
CACHE_V2_READ_TECHTRAIL_ENABLED=false
CACHE_V2_READ_IMEI_ENABLED=false
ANALYSIS_REPLAY_ENABLED=false
IMEI_BLACKLIST_V1_ENABLED=false
```

`DECISION_CACHE_V1_READ_ENABLED` pode permanecer no default `true`. Com todas
as flags V2/Blacklist desligadas, a simples existência das tabelas novas não
altera o fluxo do motor. `IMEI_BLACKLIST_SERVICE_ID` real não é necessário.

## Sequência operacional

### Fase A — versão e ambiente

1. Revisar e fazer commit das mudanças aprovadas; não usar mudanças locais não
   versionadas como fonte do rollout.
2. Criar ou selecionar um projeto Supabase controlado, distinto de produção.
3. Fazer deploy da versão aprovada nesse ambiente com as flags acima e
   `ENRICHMENT_MODE=mock` ou `off`.
4. Confirmar que nenhuma credencial real de TechTrail/IMEI é necessária nesta
   fase.

### Fase B — precheck

1. Abrir o SQL Editor do projeto controlado.
2. Executar integralmente
   `supabase/verification/cache_v2_precheck.sql`.
3. Copiar todos os result sets, preservando os rótulos `check_group`.
4. Prosseguir somente se os três targets estiverem `SAFE_TO_CREATE`, não houver
   `NAME_CONFLICT`, e a role tiver capacidade de criar no database/schema.
5. Se qualquer target já existir, parar. Comparar colunas, constraints, índices
   e RLS; `CREATE TABLE IF NOT EXISTS` não corrige schema incompatível.

### Fase C — migration manual

1. Confirmar novamente que o projeto selecionado é o ambiente controlado.
2. Executar manualmente e uma única vez
   `supabase/migrations/202608270001_cache_v2_foundation.sql`.
3. Guardar o resultado da execução. Não executar migrations adicionais.

### Fase D — postcheck

1. Executar integralmente
   `supabase/verification/cache_v2_postcheck.sql`.
2. Copiar todos os result sets.
3. Exigir `PASS` para extensão/função, tabelas/RLS, colunas, constraints e
   índices.
4. Confirmar na matriz `08_role_access`:
   - `anon_has_any_crud=false`;
   - `authenticated_has_any_crud=false`;
   - todos os quatro privilégios `service_role_can_* = true`.
5. Nenhuma policy permissiva para clientes é esperada nesta fase.

### Fase E — CRUD da service role

1. Revisar o resultado completo do postcheck antes de qualquer escrita.
2. Executar
   `supabase/verification/cache_v2_service_role_check.sql` no projeto
   controlado, em uma sessão administrativa capaz de `SET LOCAL ROLE
   service_role`.
3. O script não contém chave e usa somente identificadores `synthetic-*`.
4. Verificar:
   - `effective_role=service_role`;
   - SELECT retorna contagens;
   - três INSERTs retornam IDs;
   - três UPSERTs retornam payload com `revision=2`;
   - três DELETEs retornam IDs;
   - `07_cleanup.remaining=0` para as três tabelas;
   - o script termina em `ROLLBACK`.
5. Esse teste confirma privilégios/RLS da role no banco. A ligação entre a
   variável server-side e a service-role key será confirmada posteriormente
   pelo smoke da aplicação; nunca cole ou imprima a key no SQL Editor.
6. Se qualquer operação falhar, manter todas as flags desligadas e enviar o
   erro/result sets para revisão. Não adicionar grant por tentativa.

### Fase F — HMAC

Gerar uma chave exclusiva por ambiente, aleatória, estável, com pelo menos 256
bits de entropia e diferente de API keys, service-role key e credenciais dos
providers. Exemplo genérico executado localmente:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Copiar o resultado diretamente para o secret manager do ambiente como
`EVIDENCE_LOOKUP_HMAC_KEY`. Não colocar o valor em `.env.example`, arquivo
versionado, log, ticket ou documentação. Rotação muda os lookup tokens e deve
ser tratada como invalidação planejada; não rotacionar durante o smoke.

### Fase G — smoke sem providers pagos

Executar somente após aprovação dos resultados das fases B–F. Usar payloads
completamente sintéticos, sem `imeiCode`, e manter:

```dotenv
ENRICHMENT_MODE=mock
ENRICHMENT_MOCK_MS=0
DECISION_CACHE_V1_READ_ENABLED=false
IMEI_BLACKLIST_V1_ENABLED=false
CACHE_V2_READ_IMEI_ENABLED=false
```

Sequência planejada:

1. **Write:** usar `CACHE_V2_WRITE_ENABLED=true`, reads V2 e Replay `false`.
   Enviar a proposta sintética `cache-v2-smoke-p1`. Esperar uma linha TechTrail
   mock e uma linha Replay. Não há IMEI no payload.
2. **TechTrail HIT:** manter write ligado, habilitar somente
   `CACHE_V2_READ_TECHTRAIL_ENABLED=true` e enviar os mesmos dados/CPF com
   `proposalId=cache-v2-smoke-p2`. A mudança de proposta impede Replay da
   primeira análise; a identidade de pessoa deve reutilizar a evidência mock.
3. **Replay HIT:** habilitar `ANALYSIS_REPLAY_ENABLED=true` e repetir exatamente
   a proposta `cache-v2-smoke-p2`. Replay deve responder antes dos evidence
   caches e do engine.
4. Confirmar pela telemetria interna e por SELECTs controlados os estados de
   write, TechTrail HIT e Replay HIT. Não usar presença de rows como única prova
   de que o caminho de leitura ocorreu.
5. Ao terminar, desligar novamente todas as flags V2.

Esse smoke usa apenas o provider mock local e requer zero chamadas pagas.

### Fase H — providers reais

Somente após aprovação separada do smoke, confirmação do
`IMEI_BLACKLIST_SERVICE_ID`, credenciais e controles de custo, preparar a etapa
de providers reais. Ela não faz parte deste runbook.

## Rollback operacional

1. Definir imediatamente como `false`:
   `CACHE_V2_WRITE_ENABLED`, `CACHE_V2_READ_TECHTRAIL_ENABLED`,
   `CACHE_V2_READ_IMEI_ENABLED`, `ANALYSIS_REPLAY_ENABLED` e
   `IMEI_BLACKLIST_V1_ENABLED`.
2. Fazer redeploy/restart necessário para aplicar as flags e validar o fluxo V1.
3. Preservar as três tabelas e seus dados para diagnóstico.
4. Não dropar tabelas durante resposta a incidente.
5. Não remover `pgcrypto` automaticamente; a extensão pode ter outras
   dependências no projeto.
