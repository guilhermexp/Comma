# Tarefas

## 1. Helper: componentes de modelo

- [x] 1.1 Manifesto com `components` (`asr`, `diarization`) no gerador `scripts/transcriber-models-manifest.ts` e no `models-manifest.json`. Verificar: `--check` reproduz o manifesto e o teste do gerador cobre os componentes.
- [x] 1.2 `ModelStore`/`Installer`/`ManifestVerifier` por componente, começando por testes que falham:
  - instalar só `diarization` não baixa nem cria arquivos do `asr`;
  - instalar `asr` depois não apaga o separador;
  - `remove --component asr` mantém o separador;
  - árvore antiga sem marcadores conta como os dois componentes.

  Verificar com `swift test`.
- [x] 1.3 CLI C5: `install|remove --component`, e `status` com `components` e `componentBytes`. Verificar com testes do parser e dos eventos, e com um `install --component diarization` real em `/tmp` que baixa ~22 MB e termina em `ok`.

## 2. Helper: motor de nuvem e roteamento

- [x] 2.1 Divisor de áudio com AVFoundation passthrough (D4), começando por testes que falham:
  - um arquivo abaixo do limite não é cortado;
  - um arquivo maior vira pedaços abaixo de `maxUploadBytes`, com 2 s de sobreposição e no máximo 10 min cada;
  - os tempos de início vêm do asset exportado.

  Verificar com `swift test` usando áudio gerado no teste.
- [x] 2.2 Junção de palavras entre pedaços: rebase, regra do meio da sobreposição, fallback para segmentos quando o provedor não devolve `words`. Começar por teste com uma fala atravessando a emenda (nem perdida nem duplicada).
- [x] 2.3 Cliente de nuvem `URLSession`:
  - multipart, `verbose_json`, `timestamp_granularities[]`;
  - envio sequencial;
  - 429 com `retry-after` dentro do prazo de 420 s;
  - mapeamento para `cloud_auth_rejected|cloud_unreachable|cloud_server_error|cloud_timeout|cloud_bad_response|cloud_quota`.

  Começar por testes contra um servidor HTTP falso em loopback, cobrindo cada código, 429 curto (espera e conclui) e 429 longo (falha de cota).
- [x] 2.4 Rotas C6 `PUT /v1/provider`, `POST /v1/provider/verify` e `/health` estendido, com a configuração só em memória. Testes de rota: bearer, corpo inválido, provedor trocado entre trabalhos, chave nunca escrita em log.
- [x] 2.5 Roteador do trabalho (D1/D6) e resposta C7:
  - Local → motor atual;
  - nuvem → diarização local + cliente de nuvem + fusão;
  - falha com `asr` instalado → fallback local com `fallback`;
  - sem `asr` → 502 `cloud_asr_failed`;
  - sem separador ou configuração → 409 `cloud_asr_not_ready`.

  Testes com motores falsos para cada caminho. Verificar também com `curl` real contra a Groq usando a chave do dono: duas vozes rotuladas, mais uma gravação gerada de ~30 min cortada em pedaços.

## 3. Backend

- [x] 3.1 `SalixLlm.Transcribe` repassa `provider`, `model` e `fallback` da resposta nos metadados, e mapeia 502 `cloud_asr_failed` para `{:cloud_asr_failed, reason}`. Começar por teste que falha em `transcribe_test.exs` com o servidor de teste local.
- [x] 3.2 SSE de `recording_transcription.ex` com os campos de 3.1 no resultado e motivo `cloud_asr_failed:<reason>` no erro; `audio.transcribe` com mensagem equivalente. Testes em `recording_transcription_test.exs`, `agent_audio_transcriber_test.exs` e `tools_media_test.exs`.

## 4. Electron main e ponte

- [x] 4.1 Guarda da configuração com `safeStorage` em `<dataDir>/asr-provider.bin` (0600), começando por testes que falham:
  - grava e lê cifrado;
  - o arquivo não contém a chave em texto;
  - sem `safeStorage`, os provedores de nuvem ficam indisponíveis com `secure_storage_unavailable`.
- [x] 4.2 Entrega ao helper: `PUT /v1/provider` depois de pronto, a cada reinício e a cada mudança; reenvio quando `/health` informa `configured:false`. Testes com helper falso, cobrindo também que a chave não aparece em argv, env nem logs.
- [x] 4.3 Verificação D7: `GET /models`, depois `POST /v1/provider/verify` em 404/405, e a regra de URL. Testes de válida, recusada, inalcançável, URL `http` externa recusada e preset Groq com URL fixa.
- [x] 4.4 Instalação do separador ao escolher nuvem, e "Remover" do modelo local respeitando D3. Testes com o helper falso estendido (C5).
- [x] 4.5 Folha `meetingTranscription` (C8) com `setProvider`, `clearKey` e `retryVerify`, mais o evento `notice`, regenerada com `pnpm --dir clients generate:native-bridge`. Testes de registro, permissão e estado.
- [x] 4.6 `transcription.ts` e `electron-main.module.ts`:
  - gravar `provider`, `model` e `fallback` no `.transcript.json`;
  - emitir aviso de fallback e de "Configure a transcrição";
  - suprimir "Instale a transcrição local" fora do provedor Local.

  Testes em `audio-capture.test.ts`.

## 5. Interface

- [x] 5.1 Seção de Reunião (D8):
  - seletor de mecanismo;
  - campos Groq (chave com máscara + modelo) e compatível (URL, chave, modelo);
  - Salvar com estado da verificação;
  - chave salva sem exibir o valor, com Substituir e Apagar;
  - aviso de privacidade com o nome do provedor;
  - linha do separador;
  - linha do modelo local mantida.

  Seguir `~/.agents/skills/impeccable/SKILL.md`, com textos em `en`, `pt-BR` e `zh-CN`. Verificar com testes de componente por estado, `pnpm --dir clients test:unit` e capturas de cada estado.
- [x] 5.2 Avisos (fallback, configurar, instalar local só com Local) e gate do "Transcrever" no Drive por `meetingTranscription.ready`. Verificar com testes de componente e capturas.

## 6. Integração

- [x] 6.1 E2E no app empacotado em modo local:
  - escolher Groq com a chave do dono e ver o separador instalado sozinho;
  - transcrever uma gravação de duas vozes e conferir `Speaker 1/2` e `provider: groq` no `.transcript.json`;
  - cortar a rede e ver o fallback local com aviso (com modelo local instalado);
  - sem modelo local, ver o erro do provedor com "Tentar de novo";
  - voltar para Local.

  Registrar capturas e logs.
- [ ] 6.2 Gravação de ~2 h pela Groq: pedaços, tempos contínuos até o fim, emendas sem repetição, tempo total dentro do prazo; e 429 real ou simulado com `retry-after`.
- [x] 6.3 Busca da chave em texto nos arquivos de dados, logs e `ps` durante uma transcrição: nada encontrado.
- [x] 6.4 Atualizar `clients/apps/electron/RELEASE.md` e as notas da release: provedores, cota gratuita da Groq, privacidade, fallback e onde a chave fica. Verificar com `pnpm docs:check`.

## Acompanhamento do fluxo

- Revisão de código com `/requesting-code-review` (áreas sensíveis: chave de API, envio de áudio para fora, rota de configuração do helper).
- Publicar a release seguinte depois do aceite.
- Arquivar com `/openspec-archive-change`, rodar `/sync` e `/cleanup`.
