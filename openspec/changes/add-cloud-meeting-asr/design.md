# Design

## Contexto

Motivação em `proposal.md`. Requisitos em `specs/meeting-transcription-providers/spec.md`. Base: `add-local-meeting-asr`, já na main (contratos C1–C4 do design dela). Estado atual, levantado no código:

- **Helper `CommaTranscriber`:**
  - `TranscriptionServer` (NWListener) atende `GET /health` e `POST /v1/audio/transcriptions`. O motor `FluidTranscriptionEngine` faz ASR Parakeet, diarização offline e a fusão `mergeWordsWithSpeakers`, e devolve `EngineResult` (palavras + turnos).
  - Não existe cliente HTTP de saída nem divisor de áudio. `ModelHub.offlineMode = true` no `serve`.
  - `ModelStore` só sabe "instalado ou não": a pasta `<root>/<manifest.id>` inteira. Por isso a diarização não pode ser instalada sozinha hoje. `makeStaging` apaga pastas estranhas e `remove` apaga a raiz.
- **Electron:**
  - `LocalTranscriptionManager` (`src/main/local-transcription/manager.ts`) roda `status|install|remove`.
  - `LocalBackendService.#asrSpec` sobe o `serve` sob `taskpolicy`, com o token num arquivo 0600, e o helper fica vivo enquanto o backend local roda.
  - O único segredo guardado com Keychain é a sessão (`secure-store.ts`, `safeStorage`). Os outros segredos locais são arquivos 0600.
- **Backend:**
  - `SalixLlm.Transcribe` (protocolo `audio_transcriptions`) espera `verbose_json` e só tem nome próprio para o erro 409 `local_asr_model_not_installed`; os demais viram `{:asr_http, status, …}`.
  - Os prazos são 600 s (`@batch_timeout`), 610 s no SSE e 620 s no cliente Electron.
- **Groq:**
  - endpoint `https://api.groq.com/openai/v1/audio/transcriptions`, compatível com OpenAI;
  - modelos `whisper-large-v3` (WER 10,3%) e `whisper-large-v3-turbo` (12%);
  - arquivo até 25 MB no plano gratuito; `verbose_json` com `segments`, e palavras via `timestamp_granularities[]=word`;
  - limites de 20 RPM, 2.000 RPD, 7.200 s de áudio por hora e 28.800 s por dia; 429 vem com `retry-after`.

## Objetivos / Não objetivos

**Objetivos:**
- O backend continua chamando só o helper local. A escolha do provedor fica entre o Electron e o helper.
- A chave da API nunca fica em texto puro em disco.
- O resultado tem o mesmo formato, com quem fala, seja qual for o provedor.

**Não objetivos:**
- Selecionar o idioma.
- Usar o prompt de vocabulário.
- Tradução.
- Diarização feita pelo provedor.
- Paralelizar os pedaços enviados à nuvem: o envio é sequencial, para não estourar 20 RPM.

## Decisões

### D1. O helper é o portão da transcrição

O helper recebe a configuração do provedor em memória e decide, a cada trabalho, entre o motor local e o motor de nuvem. O backend, o template `local-meeting-asr` e o contrato C2 de entrada ficam como estão; o campo `model` do multipart continua ignorado.

Alternativa descartada: o backend chamar a Groq direto. Exigiria ffmpeg para cortar o áudio (o app não tem), perderia a diarização local e espalharia a chave para o banco do backend (template `provider_config.api_key`).

### D2. Chave cifrada com `safeStorage` e entregue ao helper por rota autenticada

- **Guarda:** o Electron guarda `{selected, cloud?: {kind, baseUrl, model, apiKey}}` cifrado com `safeStorage.encryptString` em `<dataDir>/asr-provider.bin` (0600). A chave de cifra fica no Keychain ("Comma Safe Storage").
  - `selected` é o provedor escolhido; `cloud` é a última configuração de nuvem aceita. Um provedor de nuvem escolhido é sempre o de `cloud`.
  - Escolher Local mantém `cloud`, cifrado. Voltar para esse provedor reusa a chave salva sem colá-la de novo, depois de nova verificação.
  - Só "Apagar" remove `cloud`. Se esse provedor estava escolhido, o mecanismo volta para Local.
  - Sem `cloud`, o arquivo não existe.
- **Entrega:** depois que o helper fica pronto, a cada reinício dele e a cada mudança de configuração, o Electron faz `PUT /v1/provider` (C6) com o token do helper. O helper guarda a configuração só em memória.
- **Reenvio:** `/health` informa `provider.configured`. Se o helper reiniciou e perdeu a configuração, o gerenciador a reenvia.
- **Sem `safeStorage`:** se a cifra não estiver disponível, os provedores de nuvem ficam indisponíveis, com motivo explícito. Não há fallback para texto puro.
- **Alternativas descartadas:**
  - arquivo 0600 em texto puro: quebra a promessa de Keychain;
  - Keychain acessado pelo helper: o helper tem assinatura ad hoc que muda a cada build, então o macOS pediria acesso a cada atualização.

### D3. Modelos por componente

- **Manifesto:** ganha `components`: `asr` = repo `parakeet-tdt-0.6b-v3`, `diarization` = repo `speaker-diarization`.
- **Store:** grava um marcador por componente (`<root>/<manifest.id>/.installed-<componente>`). `makeStaging` e `ManifestVerifier` passam a operar no subconjunto do componente sem apagar o outro.
- **Migração:** uma árvore já instalada pela versão anterior, sem marcadores, conta como os dois componentes instalados.
- **CLI (C5):**
  - `install --component asr|diarization|all` (padrão `all`, que é o comportamento atual);
  - `remove --component asr|all`;
  - `status` informa os componentes.
- **Gerenciador:**
  - ao selecionar um provedor de nuvem, o gerenciador instala `diarization`;
  - "Remover" na linha do modelo local remove `asr`. Remove `all` só se o provedor for Local, mantendo o separador enquanto houver um provedor de nuvem.

### D4. Divisão de áudio com AVFoundation e emendas

- **Corte:** `AVAssetExportSession` com `AVAssetExportPresetPassthrough` e `timeRange`, sem recodificar, exportando `.m4a`.
- **Tamanho do pedaço:** calculado pela taxa de bits real do arquivo para ficar abaixo de `maxUploadBytes` do provedor (Groq: 24 MB, deixando folga de 1 MB), com teto de 10 min por pedaço.
- **Sobreposição:** pedaços consecutivos se sobrepõem em 2 s. Na emenda, cada palavra fica com o pedaço em que está mais longe da borda: palavras com início antes do meio da sobreposição vêm do pedaço anterior, as demais do seguinte.
- **Palavras:** pedidas com `timestamp_granularities[]=word` e `segment`. Os tempos são rebaseados pelo início do pedaço.
- **Provedor sem palavras:** se não devolver `words`, a fusão usa os segmentos como unidade.
- **Arquivos pequenos:** um arquivo abaixo do limite vai inteiro, sem cortar.

### D5. Motor de nuvem, prazos e erros

- **Envio:** cliente `URLSession` em `TranscriberCore`, multipart com `file`, `model`, `response_format=verbose_json` e `temperature=0`. Um pedaço por vez, com timeout de 120 s por requisição.
- **Prazo do trabalho:** 420 s para a tentativa na nuvem, deixando margem para o fallback local dentro dos 600 s do backend.
- **429:** espera o `retry-after` se ele couber no prazo; senão, falha com `cloud_quota`.
- **Mapeamento de falhas:**
  - 401/403 → `cloud_auth_rejected`;
  - erro de rede ou DNS → `cloud_unreachable`;
  - 5xx → `cloud_server_error`;
  - prazo estourado → `cloud_timeout`;
  - resposta inválida → `cloud_bad_response`.
- **Diarização:** roda localmente sobre o arquivo inteiro, em paralelo com o envio, sob a mesma prioridade `utility`. A fusão reutiliza `mergeWordsWithSpeakers`, com a regra de 1 s do D5 da change anterior.

### D6. Fallback e marcação do resultado

- **Fallback:** em falha da nuvem com o componente `asr` instalado, o mesmo trabalho roda no motor local.
- **Marcação:** a resposta 200 traz `provider`, `model` e, quando houver, `fallback: {from, reason}` (C7). Sem `asr` instalado, o helper responde 502 com `cloud_asr_failed` e o motivo.
- **Backend:** repassa `provider`, `model` e `fallback` nos metadados da transcrição até o SSE e mapeia 502 `cloud_asr_failed` para o motivo `cloud_asr_failed:<reason>`, tanto no SSE quanto no `audio.transcribe`.
- **Electron:**
  - grava esses campos no `.transcript.json`;
  - em fallback, mostra o aviso "Transcrita neste Mac: <provedor> indisponível (<motivo>)";
  - com `cloud_auth_rejected`, marca o provedor como "chave recusada" na seção.

### D7. Verificação da chave

- **Quem verifica:** o Main, antes de aceitar a configuração, com `GET {baseUrl}/models` e `Authorization: Bearer`.
  - 200: válida.
  - 401/403: recusada.
  - 404 ou 405 (API compatível sem `/models`): o Main envia ao helper um teste com um WAV embutido de 1 s de silêncio, pela rota `POST /v1/provider/verify` (C6).
- **Regra de URL:** `https:` sempre; `http:` só para `127.0.0.1` ou `localhost`.
- **Groq:** a URL e a lista de modelos ficam fixas no app.

### D8. Ponte nativa e interface

- **Ponte (C8):**
  - nova folha `meetingTranscription`, com `state.subscribe` e os comandos `setProvider`, `clearKey` e `retryVerify`;
  - o estado agrega o provedor escolhido, se ele está pronto e o motivo, o estado do separador e o estado do modelo local, que continua vindo da folha `localTranscription`.
- **Seção de Reunião:**
  - linha "Mecanismo de transcrição", com seletor Local / Groq / API compatível com OpenAI;
  - campos do provedor (chave com máscara, modelo, URL), com Salvar e o estado da verificação;
  - aviso de privacidade;
  - linha do modelo local (Instalar/Remover), que continua visível para o fallback;
  - linha do separador de vozes quando o provedor é de nuvem;
  - seguir `~/.agents/skills/impeccable/SKILL.md`.
- **Aviso pós-gravação e Drive:** passam a usar `meetingTranscription.ready`. O aviso de instalar o modelo local só aparece com o provedor Local; com nuvem mal configurada, aparece "Configure a transcrição".

## Contratos novos

### C5. CLI do helper (extensão de C1)

- **`status`:** acrescenta `"components":{"asr":bool,"diarization":bool}` e `"componentBytes":{"asr":n,"diarization":n}`. `installed` continua igual a `asr && diarization`.
- **`install --component asr|diarization|all`:** mesmo JSONL de C1; `totalBytes` é o do componente.
- **`remove --component asr|all`:** `{"type":"result","ok":true}`.

### C6. Rotas novas do `serve` (bearer obrigatório)

- **`PUT /v1/provider`**, corpo JSON:
  - `{"kind":"local"}`, ou
  - `{"kind":"groq"|"openai_compatible","baseUrl":"https://…","model":"…","apiKey":"…","maxUploadBytes":n}`.

  Respostas: `204`, ou `400 {"error":{"code":"bad_request"}}`.
- **`POST /v1/provider/verify`**, mesmo corpo de um provedor de nuvem, sem gravar nada:
  - `200 {"ok":true}`;
  - `200 {"ok":false,"reason":"cloud_auth_rejected"|"cloud_unreachable"|"cloud_server_error"|"cloud_bad_response"}`.
- **`GET /health`** acrescenta `"provider":{"kind":"local"|"groq"|"openai_compatible","configured":bool}` e `"components":{"asr":bool,"diarization":bool}`. O campo `model` de C2 continua refletindo o componente `asr`.

### C7. Resposta de `POST /v1/audio/transcriptions` (extensão de C2)

- **200 `verbose_json`:** acrescenta `"provider":"local"|"groq"|"openai_compatible"`, `"model":"…"` e, quando houver fallback, `"fallback":{"from":"groq"|"openai_compatible","reason":"cloud_…"}`.
- **409 `local_asr_model_not_installed`:** só com o provedor Local.
- **502 `{"error":{"code":"cloud_asr_failed","reason":"cloud_…","provider":"…","message":"…"}}`:** falha da nuvem sem `asr` instalado.
- **409 `{"error":{"code":"cloud_asr_not_ready","reason":"diarization_missing"|"provider_unconfigured"}}`:** provedor de nuvem sem pré-requisitos.

### C8. Estado da folha `meetingTranscription`

```
{
  provider: "local" | "groq" | "openai_compatible",
  ready: bool,
  reason?: "local_model_missing" | "key_missing" | "key_rejected" | "diarization_missing" | "secure_storage_unavailable" | "unsupported",
  cloud?: { kind: "groq" | "openai_compatible", model, baseHost, hasKey, verification: "idle" | "checking" | "valid" | "rejected" | "unreachable" },
  diarization: "not_installed" | "downloading" | "ready" | "failed"
}
```

- `cloud` descreve a configuração de nuvem salva, também com Local escolhido; some quando a chave é apagada.
- `setProvider` sem `apiKey` reusa a chave salva do mesmo provedor e da mesma origem de URL; `openai_compatible` sem `baseUrl` reusa a URL salva.

Folhas relacionadas:
- `localTranscription` continua como em C1–C4, para o modelo local;
- evento `meetingTranscription.notice`, com `{kind: "fallback" | "cloud_failed" | "configure" | "install_local", reason?, provider?, recording}`:
  - `cloud_failed`: a nuvem falhou sem modelo local para assumir (502 `cloud_asr_failed`). Traz `reason` (`cloud_…`) e `provider` (`groq` | `openai_compatible`). O aviso nomeia o provedor e o motivo em palavras simples, com "Tentar de novo" (transcreve a gravação de novo) e "Mostrar no Drive", sem sugerir instalar o modelo local.

## Riscos / Trade-offs

- **[R1] Cota gratuita da Groq** (7.200 s de áudio por hora): uma chamada de 2 h esgota a hora. → Fallback local quando instalado e erro claro quando não; a seção mostra o limite em texto.
- **[R2] Palavras na emenda dos pedaços:** podem sumir ou duplicar. → Sobreposição de 2 s, regra do meio da sobreposição e teste com fala atravessando a emenda.
- **[R3] Passthrough do AVFoundation:** corta em fronteira de pacote AAC, com erro de dezenas de milissegundos. → Rebase pelo tempo real do pedaço exportado (`CMTime` do asset gerado), não pelo pedido.
- **[R4] Prazo de 600 s do backend:** 420 s de nuvem mais o fallback local de uma gravação de 2 h (~15 s medidos para 10 min) cabem. → Teste de aceitação com 2 h.
- **[R5] `safeStorage` indisponível** (Keychain bloqueado): → provedores de nuvem indisponíveis, com motivo, sem degradar para texto puro.
- **[R6] Provedor compatível que difere da OpenAI** (sem `words`, sem `/models`): → fallback para segmentos e verificação por transcrição de teste.
- **[R7] Privacidade:** o áudio sai do Mac. → Aviso explícito, padrão Local, e envio só depois de uma escolha explícita.

## Plano de migração

- **Árvore de modelos instalada pela versão anterior:** conta como `asr` + `diarization` (D3).
- **Instalações existentes:** começam em Local; nada é enviado à nuvem sem ação do usuário.
- **Rollback:** a versão anterior do helper ignora `asr-provider.bin` e os marcadores de componente, e considera instalado qualquer `<root>/<manifest.id>` existente. Com os dois componentes instalados, a árvore continua válida para ela. Com só o separador, ela informaria "instalado" e falharia o trabalho com 500. Por isso, antes de voltar de versão com só o separador instalado, é preciso usar "Remover" (ou apagar `Comma/Models`).

## Perguntas em aberto

Nenhuma.
