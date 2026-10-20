# Design

## Contexto

Motivação em `proposal.md`. Requisitos em `specs/meeting-local-transcription/spec.md`. Estado atual, levantado no código:

- **Captura:** o recorder grava áudio do sistema + microfone e salva um `.m4a` mono em AAC de 48 kbps no Drive (`audio-capture/index.ts`, `RecordingEncoder.swift`). Ao salvar, o Main envia o arquivo para `POST /v1/comma/me/recordings/transcribe`, por SSE (`audio-capture/transcription.ts:34-107`).
- **Limite de 30 MiB:** é aplicado em quatro pontos: cliente, `recording_transcription.ex:5`, `agent_audio_transcriber.ex:9` e `audio_chunker.ex:6`.
- **Pipeline do backend:** `AgentAudioTranscriber` resolve `meetings.asr_template` → `SalixLlm.Transcribe`. Em seguida, `AudioChunker` corta o áudio com ffmpeg em pedaços de 300 s, cada pedaço vai para `POST {base_url}/chat/completions` com `input_audio`, e o resultado volta como `[HH:MM:SS]` rebaseado. A tarefa de resumo usa a mesma resolução pela ferramenta `audio.transcribe`.
- **Backend local (`local-backend/`):**
  - supervisiona postgres, redis, minio e comma com `ProcessSupervisor`;
  - aloca portas de loopback em `ports.ts`;
  - grava `config.json` em modo 0600 (`config.ts`), sem a chave `meetings`;
  - usa `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (não há ffmpeg);
  - executa `Comma.LocalInstall.run()` a cada abertura.
- **Helpers Swift:** `MicCaptureHost` é SwiftPM (tools 6.2, macOS 14), compilado por `build-native.ts`, copiado para `dist/native/macos/` e empacotado em `Contents/Resources/native/macos/`. A assinatura extra é listada em `sign-macos-app.ts:113-115`.
- **FluidAudio v0.17.7** (8 de outubro de 2026):
  - `encoderPrecision: .int8V2` precisa ser pedido explicitamente; o padrão `.int8` carrega outro encoder;
  - o downloader não confere SHA-256;
  - o diarizador offline trava no macOS 14 (issue #878);
  - o diarizador cria workers `.userInitiated`, sem opção de prioridade;
  - áudio longo pede `melChunkContext: true` (issue #954).

## Objetivos / Não objetivos

**Objetivos:**
- Um processo nativo, sem Python, que transcreve e separa vozes no Neural Engine.
- Reutilizar o caminho de transcrição que já existe no backend, para que o upload do cliente e a ferramenta `audio.transcribe` da tarefa de resumo usem o mesmo modelo.
- Usar um protocolo que também sirva para provedores na nuvem compatíveis com OpenAI no futuro.

**Não objetivos:**
- Mudar o protocolo `chat_completions` atual ou o `AudioChunker`.
- Tornar o modelo selecionável na interface: há uma única variante fixada.
- Funcionar no modo de backend remoto.

## Decisões

### D1. Helper `CommaTranscriber` (SwiftPM) com FluidAudio fixado

- **O pacote:** novo pacote em `clients/apps/electron/native/macos/CommaTranscriber`, com tools 6.2 e `.macOS(.v14)` para compilar; a checagem de macOS 15 acontece em tempo de execução. A dependência `FluidAudio` fica `exact: "0.17.7"`, com `Package.resolved` versionado.
- **Os subcomandos:** um executável com
  - `status`
  - `install`
  - `remove`
  - `serve --port --token-file --models-dir`
- **Comunicação:** os subcomandos não-`serve` escrevem JSONL no stdout (`{"type":"progress","phase":…,"fraction":…}`, `{"type":"result",…}`), no mesmo padrão de troca de mensagens do `MicCaptureHost`.
- **Alternativas descartadas:**
  - `fluidaudiocli`: não tem servidor, não verifica checksum e exigiria dois processos por trabalho;
  - parakeet.cpp: usa a GPU, e o dono escolheu o Neural Engine.

### D2. Download pelo FluidAudio, verificação pelo Comma

O `install`:
1. fixa `ModelRegistry.revisionOverrides` nas revisões pinadas: Parakeet `7dd20fe6b1797d35f5e3307e8b1732d9a178edfe`, diarização `df2625ac79a7ac6b65ad868fee6d80f320da4232`;
2. baixa com `ModelHub.download(..., variant: "int8-v2")` para uma pasta de staging `Models/.staging-<uuid>`;
3. confere SHA-256 e tamanho de **todos** os arquivos de runtime contra `models-manifest.json`, compilado no helper;
4. troca o staging pela pasta final `Models/` com um rename atômico;
5. carrega uma vez (`AsrModels.loadLocal` + `OfflineDiarizerModels.load`) para preparar a compilação do Core ML, e descarrega.

Detalhes:
- **Progresso:** "baixando" é a soma de bytes do manifesto (~654 MB). "Preparando" é uma fase separada, sem porcentagem, porque o progresso do SDK não é monotônico.
- **Pasta:** `~/Library/Application Support/Comma/Models`, separada de `local/` para que remover o backend e remover o modelo sejam independentes.
- **Manifesto:** o SHA-256 dos pesos vem dos metadados LFS do Hugging Face. O dos arquivos Git comuns (`coremldata.bin`, `model.mil`, `*.json`) é calculado a partir dos bytes baixados da revisão fixada, quando o manifesto é gerado. O manifesto inclui as licenças/NOTICE copiadas para a atribuição.
- **Alternativa descartada:** baixar direto pelo Electron main. Daria para reaproveitar `host-preparation.ts`, mas duplicaria a seleção de arquivos do SDK.

### D3. Protocolo `audio_transcriptions` no backend, arquivo inteiro

`SalixLlm.Transcribe` ganha um ramo para `provider_config.protocol == "audio_transcriptions"`:
- **Envio:** `POST {base_url}/audio/transcriptions` multipart (`file`, `model`, `response_format=verbose_json`) com o arquivo **inteiro**. Esse ramo não passa pelo `AudioChunker` nem pelo ffmpeg.
- **Montagem do texto:** as linhas `[HH:MM:SS] Speaker N: texto` são montadas a partir de `segments[]`. Quando o segmento traz `speaker`, ele é numerado por ordem de primeira aparição. Sem `speaker`, a linha sai sem o rótulo.
- **Onde o ramo entra:** `transcribe_audio_stream_with_metadata` escolhe o ramo antes do chunker. Os metadados (`duration_seconds`, `chunks`) vêm da resposta: um único chunk com offset 0.
- **Por que o arquivo inteiro:** a diarização precisa da gravação toda para manter "Speaker 1" como a mesma pessoa do começo ao fim. Cortar em pedaços de 300 s quebraria isso. Bônus: some a dependência do ffmpeg no app.
- **Compatibilidade:** é o subconjunto do `/v1/audio/transcriptions` da OpenAI (e do OpenRouter, que também devolve `speaker` em `segments`). Um provedor de nuvem futuro entra só por configuração.
- **Alternativa descartada:** manter o `chat_completions` e fazer o helper imitar um LLM com `input_audio`. Exigiria o ffmpeg e o corte em pedaços, e perderia a diarização global.

### D4. Servidor HTTP mínimo no helper com `Network.framework`

- **Implementação:** `serve` usa `NWListener` em `127.0.0.1` e atende só duas rotas:
  - `GET /health` → `{"status":"ok"}`, o contrato de prontidão do supervisor (`runtime.ts:61-71`);
  - `POST /v1/audio/transcriptions`.
- **Upload:** o corpo multipart é gravado em um arquivo temporário, com limite de 64 MiB.
- **Autenticação:** exige `Authorization: Bearer <token>`; sem ele, 401.
- **Fila:** uma transcrição por vez; as outras esperam.
- **Modelo ausente:** sem modelo pronto, responde 409 com `{"error":{"code":"local_asr_model_not_installed"}}`. O backend mapeia esse código para o motivo `local_asr_model_not_installed` no SSE.
- **Alternativa descartada:** SwiftNIO. É uma dependência grande para duas rotas.

### D5. Trabalho: ASR + diarização, fusão e liberação

Para cada requisição:
1. `AsrManager` com `ASRConfig(parallelChunkConcurrency: 1, melChunkContext: true)` e `encoderComputeUnits: .cpuAndNeuralEngine`, com timestamps de token → palavras (`buildWordTimings`);
2. `OfflineDiarizerManager.process(url)` sobre o mesmo arquivo;
3. cada palavra vai para o segmento de voz com maior sobreposição de tempo (varredura ordenada). Uma palavra sem sobreposição vai para o segmento mais próximo a até 1 s, porque a primeira palavra de uma fala costuma começar um pouco antes do segmento do diarizador. Mais longe que isso, a palavra fica sem speaker;
4. palavras seguidas do mesmo speaker viram um segmento;
5. `asr.cleanup()` e a liberação de todas as referências de modelos ao fim do trabalho.

O helper lê o `.m4a` direto, porque o FluidAudio converte o arquivo.

**Prioridade:** o `serve` é iniciado pelo supervisor através de `/usr/sbin/taskpolicy -c utility`, que limita o QoS de todas as threads do processo, inclusive os workers `.userInitiated` do diarizador. Isso fecha a lacuna do SDK, que não deixa escolher a prioridade.

### D6. Integração no backend local

- **Porta:** `ports.ts` ganha a porta `asr`.
- **Token:** `secrets.json` ganha `asrToken` (gerado uma vez) e o helper o lê por `--token-file` (0600). O token não vai na linha de comando.
- **Processo:** `service.ts` ganha `#asrSpec()`, iniciado depois do minio e antes do backend, e incluído em `stopOrder`/`orphanOrder`. Ele sobe mesmo sem modelo instalado: ocioso, sem modelo, é só um socket.
- **Configuração:** `config.ts` passa a gravar `meetings.asr_template: "local-meeting-asr"` e `meetings.local_asr: {base_url, api_key}`. A cada abertura, `Comma.LocalInstall.run()` faz um upsert do template global `local-meeting-asr` (model `parakeet-tdt-0.6b-v3`, `provider_config.protocol = "audio_transcriptions"`, `base_url`/`api_key` vindos de `meetings.local_asr`), porque a porta pode mudar.
- **Instalar/remover:** os subcomandos rodam como processos curtos, disparados pelo Main, independentes do `serve`. O `serve` relê o estado do modelo a cada requisição. Remover é recusado se o `serve` informar um trabalho ativo (`GET /health` inclui `busy`).
- **Alternativa descartada:** fazer o Electron chamar o helper direto, sem o backend. Cobriria o upload do cliente, mas não a ferramenta `audio.transcribe` da tarefa de resumo.

### D7. Ponte nativa e interface

- **Ponte:** uma nova folha `localTranscription`, no padrão de `computeNode`:
  - `state.subscribe` → `{supported, reason?, phase: not_installed|downloading|preparing|ready|failed, fraction?, sizeBytes, error?}`;
  - comandos `install`, `cancel`, `remove`.
- **Disponibilidade:** a checagem de suporte (Apple Silicon, macOS ≥ 15, backend em modo local) fica no Main.
- **Ajustes:** a seção "Transcrição local" fica em `AppSettingsRoute.tsx`, na categoria `meeting`, e mostra o estado e o progresso em texto ("Baixando 42%"). Ela usa os controles existentes, seguindo `~/.agents/skills/impeccable/SKILL.md`.
- **Aviso sem modelo:** `transcription.ts` passa a publicar o motivo `local_asr_model_not_installed` no estado do recorder/toast de gravação salva. O aviso usa o mesmo canal de `summaryError`, com a ação "Instalar".
- **Transcrever de novo:** uma ação nas gravações sem transcrição ou com `.transcript.json` em erro reenvia o arquivo pelo mesmo `process`.
- **Textos:** em `en`, `pt-BR` e `zh-CN`, exigência do `check-i18n.mjs`.

### D8. Limites de tamanho

O limite sobe de 30 MiB para 64 MiB no cliente (`transcription.ts`), em `recording_transcription.ex` e em `agent_audio_transcriber.ex`. O `AudioChunker` mantém 30 MiB, porque só atende o protocolo `chat_completions`, que não muda. Duas horas a 48 kbps dão ~41 MiB.

## Riscos / Trade-offs

- **[R1] Qualidade em pt-BR:** o Parakeet v3 foi treinado com português europeu, então nomes próprios e gírias podem sair errados. → A aceitação inclui uma gravação real em pt-BR. Trocar de modelo depois é só um novo manifesto, porque o protocolo não muda.
- **[R2] Palavras perdidas em áudio longo (issue #954):** → `melChunkContext: true` mais um teste de aceitação com uma gravação longa. Se a correção sair no SDK, a versão sobe com um novo pin.
- **[R3] Primeira carga lenta (compilação do Neural Engine), sem medida pública para `int8V2`:** → a fase "Preparando" acontece na instalação, não na primeira transcrição. O cache do Core ML fica sob o controle do sistema e pode ser invalidado por atualização do macOS; aí a primeira transcrição seguinte fica mais lenta.
- **[R4] `taskpolicy -c utility` pode desacelerar demais em Mac ocupado:** → é aceitável, porque a transcrição é pós-chamada. A medida acontece na aceitação: duração de uma gravação de 10 min.
- **[R5] O SDK pode baixar arquivos além do manifesto (`config.json`, vocab duplicado):** → a verificação cobre os arquivos de runtime. Arquivos extras sem hash são apagados antes do rename.
- **[R6] Atribuição de licença (CC BY 4.0 do Parakeet e da diarização Community-1):** → os textos de licença e NOTICE vão para `Contents/Resources/licenses/`, citando pyannote, WeSpeaker, BUT Speech@FIT e Fluid Inference.
- **[R7] Fala sobreposta:** duas pessoas falando ao mesmo tempo ficam com um único speaker. → É uma limitação conhecida, registrada nas notas da release.

## Contratos entre as partes

Estes contratos são a fronteira entre o helper (grupo 1 e 3.1), o backend (grupo 2) e o Electron (3.2–3.5 e grupo 4). Mudar qualquer um deles exige atualizar este design primeiro.

### C1. CLI do helper `CommaTranscriber`

Todos os subcomandos aceitam `--models-dir <dir>`. O padrão é `~/Library/Application Support/Comma/Models`. Cada linha do stdout é um objeto JSON; o stderr é só log.

- **`status`:** uma linha `{"type":"status","supported":bool,"reason":"unsupported_cpu"|"unsupported_os"|null,"installed":bool,"downloadBytes":<total do manifesto>}`, saída 0.
- **`install`:**
  - progresso: `{"type":"progress","phase":"downloading","fraction":0..1,"bytes":n,"totalBytes":n}`, depois `{"type":"progress","phase":"preparing"}`;
  - fim: `{"type":"result","ok":true}` ou `{"type":"result","ok":false,"error":{"code":"unsupported"|"network"|"checksum_mismatch"|"cancelled"|"io","message":"…"}}`;
  - código de saída 0 quando `ok`, 1 nos outros casos;
  - `SIGTERM` cancela: apaga o staging e emite `cancelled`.
- **`remove`:** `{"type":"result","ok":true}`, ou erro `io`.
- **`serve --port <p> --token-file <arquivo 0600 com o token> [--models-dir]`:** escuta só em `127.0.0.1:<p>`. É o servidor C2.

### C2. HTTP do `serve`

- **`GET /health`** (sem token): `200 {"status":"ok","busy":bool,"model":"ready"|"not_installed"}`.
- **`POST /v1/audio/transcriptions`:**
  - entrada: `Authorization: Bearer <token>`, multipart com `file` (obrigatório, m4a/mp3/wav), `model` (aceito e ignorado) e `response_format` (`verbose_json` ou `json`; padrão `json`);
  - `200 verbose_json`: `{"text":"…","duration":<segundos>,"segments":[{"id":0,"start":<s>,"end":<s>,"text":"…","speaker":"S1"|null}]}`;
  - `200 json`: `{"text":"…"}`;
  - erros: `401 {"error":{"code":"unauthorized"}}`, `409 {"error":{"code":"local_asr_model_not_installed","message":"…"}}`, `413 {"error":{"code":"file_too_large"}}` (acima de 64 MiB), `400 {"error":{"code":"bad_request","message":"…"}}`, `500 {"error":{"code":"transcription_failed","message":"…"}}`;
  - `speaker` é um rótulo opaco e estável dentro da resposta; quem consome numera por ordem de primeira aparição.

### C3. Configuração e template do backend

- **`config.json` gerado pelo Electron:**

  ```json
  "meetings": {
    "asr_template": "local-meeting-asr",
    "local_asr": { "base_url": "http://127.0.0.1:<porta asr>/v1", "api_key": "<asrToken>" }
  }
  ```

- **Template global** criado por `Comma.LocalInstall.run/0` quando `meetings.local_asr` existe:
  - `name: "local-meeting-asr"`;
  - `model: "parakeet-tdt-0.6b-v3"`;
  - `provider_config: {"protocol":"audio_transcriptions","base_url":…,"api_key":…}`.
- **Protocolo `audio_transcriptions`:** `POST {base_url}/audio/transcriptions` com `response_format=verbose_json`. Linha por segmento: `[HH:MM:SS] Speaker N: texto`, ou `[HH:MM:SS] texto` quando `speaker` é nulo.
- **Motivo no SSE de `/v1/comma/me/recordings/transcribe`** quando o servidor responde 409: `{"status":"error","reason":"local_asr_model_not_installed"}`. O Electron reconhece esse texto exato.

### C4. Arquivos no pacote do app

- Binário: `Contents/Resources/native/macos/CommaTranscriber`; em dev, `dist/native/macos/CommaTranscriber`.
- Licenças: `Contents/Resources/licenses/fluidaudio/` (Apache-2.0 do SDK, CC BY 4.0 e NOTICE dos modelos).

## Plano de migração

- Não há dado a migrar. Instalações existentes recebem o helper na próxima atualização; o modelo continua não instalado até o usuário clicar.
- O template `local-meeting-asr` é criado no próximo `LocalInstall.run()`.
- **Rollback:** a versão anterior do app ignora `meetings.local_asr`, e o template fica órfão, sem efeito. Remover o modelo apaga `Comma/Models`.

## Perguntas em aberto

- Usar o rótulo "Speaker N" ou o equivalente traduzido no texto da transcrição. Fica "Speaker N", neutro, até haver pedido; isso não muda o desenho.
