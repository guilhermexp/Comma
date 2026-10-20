# Tarefas

## 1. Helper `CommaTranscriber` (Swift)

- [ ] 1.1 Criar o pacote SwiftPM `clients/apps/electron/native/macos/CommaTranscriber` (tools 6.2, `.macOS(.v14)`, `FluidAudio` `exact: "0.17.7"`, `Package.resolved` versionado), com executável e alvo de testes. Verificar: `swift build -c release` e `swift test` passam.
- [ ] 1.2 Gerar `models-manifest.json` com caminho, tamanho e SHA-256 de cada arquivo de runtime do Parakeet v3 `int8-v2` (revisão `7dd20fe…`) e da diarização Community-1 (revisão `df2625a…`), mais os textos de licença/NOTICE. Fazer isso com um script de geração versionado em `clients/apps/electron/scripts/`. Verificar: o script recria o mesmo manifesto e os SHA-256 dos pesos batem com os metadados LFS do Hugging Face.
- [ ] 1.3 Verificador de manifesto, começando por teste que falha: um arquivo com SHA-256 ou tamanho diferente invalida a instalação, e arquivos fora do manifesto são apagados. Verificar com `swift test`.
- [ ] 1.4 Subcomandos `status`, `install` (staging → download pelo `ModelHub` com revisões fixadas → verificação de 1.3 → rename atômico → carga de preparação → descarga) e `remove`, emitindo JSONL de progresso e resultado. Também a checagem de Apple Silicon e macOS 15+. Verificar: testes de staging interrompido (nada fica "pronto"), de `remove` e de máquina não suportada; e um `install` real em `/tmp` que termina em `ready`.
- [ ] 1.5 Fusão de palavras e speakers, começando por teste que falha: cada palavra vai para o segmento com maior sobreposição, palavras seguidas do mesmo speaker se juntam, os speakers são numerados por primeira aparição e uma palavra sem sobreposição vai para o segmento mais próximo a até 1 s; mais longe que isso, fica sem speaker. Verificar com `swift test`.
- [ ] 1.6 `serve` com `NWListener` só em `127.0.0.1`:
  - `GET /health` (`status`, `busy`);
  - `POST /v1/audio/transcriptions` multipart, com limite de 64 MiB;
  - bearer obrigatório (401 sem token);
  - 409 `local_asr_model_not_installed` quando não há modelo;
  - uma transcrição por vez, na fila;
  - ASR com `melChunkContext: true` mais diarização mais fusão de 1.5;
  - `verbose_json` com `segments[{start,end,speaker,text}]`;
  - modelo liberado ao fim.

  Verificar: testes de rota (401, 409, 413, fila) e uma chamada `curl` real com um `.m4a` curto de duas vozes devolvendo segmentos com dois speakers.

## 2. Backend: protocolo `audio_transcriptions`

- [ ] 2.1 Teste ExUnit que falha em `transcribe_test.exs`: com `provider_config.protocol == "audio_transcriptions"`, o arquivo inteiro vai em multipart para `{base_url}/audio/transcriptions` sem passar pelo chunker. A resposta `verbose_json` vira linhas `[HH:MM:SS] Speaker N: texto`, e segmento sem `speaker` vira linha sem rótulo. Implementar o ramo em `SalixLlm.Transcribe`, usando um servidor HTTP de teste local. Verificar: `cd systems && mix test apps/salix_llm/test/salix_llm/transcribe_test.exs --seed 0`.
- [ ] 2.2 Mapear o 409 `local_asr_model_not_installed` para o motivo `local_asr_model_not_installed` no SSE de `recording_transcription.ex` e no erro de `audio.transcribe`. Testes em `recording_transcription_test.exs` e `agent_audio_transcriber_test.exs`.
- [ ] 2.3 Subir o limite para 64 MiB em `recording_transcription.ex` e `agent_audio_transcriber.ex`, mantendo o `AudioChunker` em 30 MiB. Testes de limite: 64 MiB aceita, acima disso 413 / `:asr_audio_too_large`.
- [ ] 2.4 `config_json.ex` passa a ler `meetings.local_asr` (`base_url`, `api_key`). `Comma.LocalInstall.run/0` faz upsert idempotente do template global `local-meeting-asr` com `protocol: "audio_transcriptions"`. Verificar: teste que roda duas vezes com portas diferentes e confere um único template com o `base_url` novo, e que sem `meetings.local_asr` nada é criado.
- [ ] 2.5 Documentar o protocolo `audio_transcriptions` e a chave `meetings.local_asr` em `systems/config/config.example.json` e em `systems/DEPLOYMENT.md`. Verificar com `pnpm docs:check`.

## 3. Electron: build, processo e ponte nativa

- [ ] 3.1 Compilar o helper em `build-native.ts` e `native-paths.ts` (`dist/native/macos/CommaTranscriber`), incluí-lo em `sign-macos-app.ts` e copiar as licenças para `Contents/Resources/licenses/`. Verificar: `pnpm build:native` gera o binário, e `codesign --verify --deep --strict` passa num `package` local.
- [ ] 3.2 Porta `asr` em `ports.ts`, `asrToken` em `secrets.json` (gerado uma vez, 0600), arquivo do token passado com `--token-file`, e `meetings.asr_template` + `meetings.local_asr` em `config.ts`. Verificar: testes de portas, segredos e snapshot da config sem segredo no log.
- [ ] 3.3 `#asrSpec()` em `service.ts`: `taskpolicy -c utility` + `serve`, iniciado depois do minio e antes do backend, com prontidão por `/health` e entrada em `stopOrder`/`orphanOrder`. Verificar: testes com processo falso (ordem, reinício, parada) e, num app real em modo local, `ps -o pri,command` mostrando o helper sob `taskpolicy`.
- [ ] 3.4 Gerenciador do modelo no Main e a folha `localTranscription` da ponte (`state.subscribe`, `install`, `cancel`, `remove`). Ele roda os subcomandos de 1.4, traduz o JSONL em estado, recusa `remove` com `busy`, e calcula `supported` (Apple Silicon, macOS ≥ 15, modo local). Verificar com testes de unidade com helper falso: progresso, falha de checksum, cancelamento, recusa de remoção e não suportado.
- [ ] 3.5 `transcription.ts`: limite de 64 MiB, publicação do motivo `local_asr_model_not_installed` no estado do recorder/toast e ação de retranscrever uma gravação salva. Verificar com testes em `audio-capture.test.ts`.

## 4. Interface

- [ ] 4.1 Seção "Transcrição local" em Ajustes → Trabalho → Reunião (`AppSettingsRoute.tsx`):
  - estados não suportado, não instalado (com tamanho), baixando %, preparando, pronto e erro;
  - Instalar, Cancelar e Remover;
  - seguir `~/.agents/skills/impeccable/SKILL.md`;
  - textos em `en`, `pt-BR` e `zh-CN`.

  Verificar: testes de componente por estado, `pnpm --dir clients test:unit` (inclui `i18n:check`) e captura de tela de cada estado.
- [ ] 4.2 Aviso "Instale a transcrição local" no recorder/toast de gravação salva, com ação que abre a seção, e ação "Transcrever" nas gravações sem transcrição ou com erro. Verificar: testes de componente e captura de tela.

## 5. Integração e release

- [ ] 5.1 E2E no Electron em modo local:
  - abrir sem modelo;
  - gravar um trecho e ver o aviso de instalar;
  - instalar e ver "Pronto";
  - transcrever a gravação anterior e conferir linhas `[HH:MM:SS] Speaker N:` no `.transcript.txt`;
  - remover e confirmar que `~/Library/Application Support/Comma/Models` sumiu.

  Registrar capturas e logs.
- [ ] 5.2 Prova de qualidade e de peso:
  - transcrever uma gravação real de chamada em pt-BR com duas pessoas e outra de ~2 h;
  - registrar o tempo de transcrição;
  - registrar o uso de CPU e GPU com `powermetrics` durante o trabalho;
  - confirmar que, ocioso, o helper não mantém o modelo na memória (RSS antes e depois).
- [ ] 5.3 Acesso: de outro dispositivo da rede, confirmar que a porta `asr` recusa conexão; localmente, sem token, receber 401.
- [ ] 5.4 CI de release: o `desktop-release.yml` compila o helper (cache SwiftPM com o novo `Package.resolved`). Verificar com `actionlint` e uma execução do workflow que gere o DMG com `Contents/Resources/native/macos/CommaTranscriber`, sem os pesos do modelo.
- [ ] 5.5 Atualizar a documentação de primeira instalação e as notas da release: onde o modelo fica, tamanho, como remover, requisitos (Apple Silicon, macOS 15+), limitações (pt europeu no treino, fala sobreposta) e atribuições. Verificar com `pnpm docs:check`.

## Acompanhamento do fluxo

- Revisão de código com `/requesting-code-review` (áreas sensíveis: processo filho, token local, download verificado).
- Publicar a release seguinte com a tag `v<versão>` depois do aceite.
- Arquivar com `/openspec-archive-change`, rodar `/sync` e `/cleanup`.
