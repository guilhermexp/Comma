# Proposta

## Por quê

A change `add-local-meeting-asr` passou a transcrever as gravações de reunião no próprio Mac com o Parakeet. O dono quer também poder usar uma API de transcrição, em especial a Groq direto (sem OpenRouter), que oferece `whisper-large-v3` e `whisper-large-v3-turbo` com cota gratuita. Isso serve para quem não quer baixar o modelo local de 654 MB, para conseguir outra qualidade em pt-BR, e como alternativa quando o modelo local não estiver instalado.

## O que muda

- Ajustes → Trabalho → Reunião ganha a escolha do **mecanismo de transcrição**:
  - **Local (neste Mac)**, o padrão e comportamento atual;
  - **Groq**, um preset com URL fixa e modelo `whisper-large-v3` (padrão) ou `whisper-large-v3-turbo`;
  - **API compatível com OpenAI**, com URL base, chave e modelo informados pelo usuário.
- A chave da API fica guardada cifrada pelo Keychain do macOS (`safeStorage`). Ela nunca aparece em texto puro no disco, em argumentos, em variáveis de ambiente ou em logs, e não é exibida de novo depois de salva.
- O helper `CommaTranscriber` continua sendo o único ponto que o backend chama. Com um provedor de nuvem selecionado, ele:
  - divide a gravação em pedaços menores que o limite do provedor (25 MB na Groq gratuita), sem ffmpeg;
  - envia os pedaços para `{url}/audio/transcriptions` e respeita o `retry-after` das respostas 429;
  - junta os tempos e rotula quem fala com o separador de vozes local.
- O separador de vozes (~22 MB) passa a ser instalável **sozinho**, sem o modelo de transcrição de 632 MB. Ao escolher um provedor de nuvem, o app instala só ele.
- Se o provedor de nuvem falhar (sem internet, cota esgotada, chave inválida, erro do servidor), a gravação é transcrita pelo modelo local quando ele está instalado. O app avisa que houve fallback e o motivo. Sem modelo local, mostra o erro do provedor com "Tentar de novo".
- Com um provedor de nuvem selecionado, os Ajustes avisam explicitamente que o áudio das reuniões será enviado a esse provedor.
- O aviso "Instale a transcrição local" e a ação "Transcrever" do Drive passam a considerar o provedor escolhido.

Fora do escopo: transcrição ao vivo durante a chamada, provedores com protocolo próprio (Deepgram, AssemblyAI etc.), separação de quem fala feita pelo provedor, e o modo de backend remoto.

## Capacidades

### Novas capacidades

- `meeting-transcription-providers`: escolha do mecanismo de transcrição das reuniões (Local, Groq, API compatível com OpenAI), guarda da chave, transcrição pela nuvem com rótulo de quem fala, divisão de gravações longas, limites de cota e fallback para o modelo local.

### Capacidades modificadas

Nenhuma em `openspec/specs/`. A change `add-local-meeting-asr`, ainda aberta, teve dois requisitos de `meeting-local-transcription` restringidos ao provedor Local, para não conflitarem com esta.

## Impacto

- **Helper** (`clients/apps/electron/native/macos/CommaTranscriber`):
  - manifesto e store de modelos divididos em componentes (`asr`, `diarization`);
  - cliente HTTP de saída (`URLSession`);
  - divisor de áudio com AVFoundation;
  - roteador de provedor e fallback;
  - rota autenticada para receber a configuração do provedor;
  - novos códigos de erro.
- **Electron main:**
  - configuração do provedor guardada com `safeStorage`, enviada ao helper;
  - instalação só do separador de vozes;
  - verificação da chave;
  - estado e comandos novos na ponte nativa (`clients/packages/native-bridge`).
- **Interface** (`clients/packages/app`):
  - seção de Reunião (seletor, campos e aviso de privacidade);
  - aviso pós-gravação e gate do Drive;
  - textos em `en`, `pt-BR` e `zh-CN`.
- **Backend** (`systems`): mapear o novo erro `cloud_asr_failed` no SSE e no `audio.transcribe`. O contrato C2 com o helper não muda.
- **Rede:** saída para `api.groq.com`, ou para a URL informada, só quando o usuário escolhe um provedor de nuvem.
