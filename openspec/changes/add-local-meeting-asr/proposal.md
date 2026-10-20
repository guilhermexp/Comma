# Proposta

## Por quê

O app desktop grava reuniões (áudio do sistema + microfone), mas a transcrição falha: o backend local não tem `meetings.asr_template` configurado e responde "Meeting ASR is not configured", gravado em silêncio num `.transcript.json`. Mesmo com um provedor configurado, o app empacotado não acharia o `ffmpeg` que o backend usa para cortar o áudio. O dono quer transcrever as chamadas no próprio Mac, sem mandar áudio para a nuvem, com um modelo que não pese no uso do computador.

## O que muda

- Novo helper nativo em Swift empacotado no app, usando o SDK FluidAudio (Core ML, Neural Engine), que transcreve com NVIDIA Parakeet TDT 0.6B v3 (`int8V2`, multilíngue, 25 idiomas) e separa quem fala com o diarizador offline Community-1.
- O modelo (~654 MB) **não** vai no DMG. Ajustes → Trabalho → Reunião ganha a seção "Transcrição local" com estado (não instalado, baixando com %, preparando, pronto, erro) e os botões Instalar e Remover. O download é verificado por SHA-256 antes de ser usado.
- O backend ganha um segundo protocolo de transcrição, compatível com o `POST /v1/audio/transcriptions` da OpenAI, que envia o arquivo inteiro e monta as linhas `[HH:MM:SS] Speaker N: texto` a partir dos segmentos devolvidos. O protocolo atual (`/chat/completions` com áudio em pedaços) continua igual.
- No modo de backend local, o app sobe o helper junto com os outros processos e configura sozinho o modelo de transcrição de reuniões apontando para ele.
- Sem modelo instalado, a gravação é salva normalmente e o app mostra um aviso com o botão de instalar, em vez de falhar em silêncio. Depois de instalar, dá para transcrever gravações já salvas.
- O limite de 30 MiB por gravação no caminho de transcrição sobe para 64 MiB, para cobrir chamadas de 2 horas.
- A transcrição roda em prioridade baixa e o modelo sai da memória ao fim de cada trabalho.

Fora do escopo: transcrição na nuvem (Groq/OpenRouter), transcrição ao vivo durante a chamada, Macs Intel e macOS 14, e o modo de backend remoto.

## Capacidades

### Novas capacidades

- `meeting-local-transcription`: instalação e remoção do modelo local de transcrição pelo app, transcrição das gravações de reunião no próprio Mac com identificação de quem fala, e o comportamento quando o modelo falta ou o Mac não é compatível.

### Capacidades modificadas

Nenhuma. `openspec/specs/` ainda não tem specs canônicas.

## Impacto

- `clients/apps/electron/native/macos/`: novo pacote SwiftPM do helper, com dependência fixada FluidAudio v0.17.7 (Apache-2.0); modelos sob CC BY 4.0, com atribuição.
- `clients/apps/electron/scripts/` (`build-native.ts`, `native-paths.ts`, `sign-macos-app.ts`), `forge.config.ts` e `.github/workflows/desktop-release.yml`: compilar, assinar e empacotar o helper.
- `clients/apps/electron/src/main/local-backend/` (`service.ts`, `ports.ts`, `config.ts`, `secrets`): novo processo filho, porta e token.
- `clients/apps/electron/src/main/modules/audio-capture/transcription.ts` e a ponte nativa (`clients/packages/native-bridge`): estado e comandos de instalação, limite de tamanho e erro de modelo ausente.
- `clients/packages/app` (`AppSettingsRoute.tsx`, ações de gravação, recorder) e i18n `en`, `pt-BR`, `zh-CN`.
- `systems/apps/salix_llm` (`transcribe.ex`), `salix_web` (`agent_audio_transcriber.ex`), `comma_web` (`recording_transcription.ex`) e `Comma.LocalInstall`: novo protocolo, limites e criação do template local.
- Disco do usuário: cerca de 654 MB em `~/Library/Application Support/Comma/Models`, mais o cache de compilação do Core ML.
