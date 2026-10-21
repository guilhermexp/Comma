# Spec Delta

## Purpose

Permitir que o usuário escolha qual mecanismo transcreve as gravações de reunião no app desktop: o modelo local, a Groq ou outra API compatível com OpenAI. Inclui guardar a chave com segurança, rotular quem fala, tratar gravações longas e limites de cota, e cair no modelo local quando a nuvem falha.

## ADDED Requirements

### Requirement: Escolha do mecanismo de transcrição

Na seção de Reunião dos Ajustes, o app MUST oferecer a escolha entre "Local (neste Mac)", "Groq" e "API compatível com OpenAI". O padrão MUST ser Local. A escolha MUST valer para as próximas transcrições, inclusive as pedidas pelo Drive e pela tarefa de resumo, sem reiniciar o app. A escolha MUST estar disponível nas mesmas condições da transcrição local (Apple Silicon, macOS 15+, backend local).

#### Scenario: Padrão

- **WHEN** o usuário abre a seção de Reunião pela primeira vez
- **THEN** o mecanismo selecionado é "Local (neste Mac)"

#### Scenario: Troca sem reiniciar

- **WHEN** o usuário troca para Groq com uma chave válida e para uma gravação logo em seguida
- **THEN** essa gravação é transcrita pela Groq

### Requirement: Configuração da Groq e de API compatível com OpenAI

Para a Groq, o app MUST pedir só a chave e oferecer o modelo `whisper-large-v3` (padrão) ou `whisper-large-v3-turbo`, usando a URL `https://api.groq.com/openai/v1`. Para a API compatível com OpenAI, o app MUST pedir URL base (HTTPS, ou HTTP só para `127.0.0.1`/`localhost`), chave e nome do modelo. Ao salvar, o app MUST verificar a chave contra o provedor e mostrar se é válida antes de aceitar a configuração.

#### Scenario: Chave válida

- **WHEN** o usuário cola uma chave válida da Groq e salva
- **THEN** a configuração é aceita e a seção mostra Groq como pronto

#### Scenario: Chave inválida

- **WHEN** o provedor recusa a chave
- **THEN** o app mostra "Chave recusada pelo provedor", mantém a configuração anterior e não troca o mecanismo

#### Scenario: URL insegura

- **WHEN** o usuário informa uma URL `http://` que não é `127.0.0.1` nem `localhost`
- **THEN** o app recusa a URL e explica que é preciso HTTPS

### Requirement: Guarda da chave

A chave MUST ser guardada cifrada com a proteção do Keychain do macOS e MUST NOT aparecer em texto puro em arquivos, argumentos de processo, variáveis de ambiente, logs ou na interface depois de salva. A interface MUST mostrar só que existe uma chave salva, com as ações de substituir e de apagar. Apagar a chave de um provedor selecionado MUST voltar o mecanismo para Local.

#### Scenario: Chave salva

- **WHEN** o usuário reabre a seção depois de salvar a chave
- **THEN** o campo mostra que há uma chave salva, sem exibir o valor

#### Scenario: Busca no disco

- **WHEN** alguém procura o texto da chave nos arquivos de dados e logs do app
- **THEN** o texto não é encontrado

### Requirement: Aviso de privacidade

Com um provedor de nuvem selecionado, a seção MUST informar que o áudio das reuniões será enviado a esse provedor, nomeando-o (Groq ou o host da URL). Com Local selecionado, a seção MUST continuar dizendo que o áudio não sai do Mac.

#### Scenario: Groq selecionada

- **WHEN** o mecanismo é Groq
- **THEN** a seção mostra que o áudio das gravações é enviado à Groq para transcrição

### Requirement: Transcrição pela nuvem com quem fala

Com um provedor de nuvem selecionado e configurado, o app MUST transcrever a gravação por esse provedor e gravar o `.transcript.txt` e o `.transcript.json` no mesmo formato da transcrição local: `[HH:MM:SS] Speaker N: texto`, com tempo relativo ao início da gravação e o mesmo número para a mesma voz ao longo da gravação. A identificação de quem fala MUST ser feita no próprio Mac, pelo separador de vozes local.

#### Scenario: Chamada com duas pessoas pela Groq

- **WHEN** o usuário grava 10 minutos com duas vozes usando a Groq
- **THEN** o `.transcript.txt` tem linhas `Speaker 1` e `Speaker 2` em ordem de tempo, e o `.transcript.json` registra `groq` e o modelo usado

#### Scenario: Separador indisponível

- **WHEN** o separador de vozes não consegue rodar
- **THEN** a transcrição sai mesmo assim, com linhas `[HH:MM:SS] texto` sem rótulo de pessoa

### Requirement: Registro do provedor usado

O `.transcript.json` de cada gravação MUST registrar qual provedor e qual modelo produziram a transcrição e, quando houver fallback, de qual provedor e por qual motivo.

#### Scenario: Transcrição pela Groq

- **WHEN** a Groq transcreve uma gravação com o modelo `whisper-large-v3`
- **THEN** o `.transcript.json` registra o provedor `groq` e o modelo `whisper-large-v3`

### Requirement: Separador de vozes instalável sozinho

Ao selecionar um provedor de nuvem, o app MUST instalar somente o separador de vozes (cerca de 22 MB), com a mesma verificação de SHA-256 e tamanho da instalação local, sem baixar o modelo de transcrição de 632 MB. A remoção do modelo local MUST NOT remover o separador enquanto um provedor de nuvem estiver selecionado.

#### Scenario: Groq sem modelo local

- **WHEN** o usuário seleciona Groq sem ter o modelo local instalado
- **THEN** o app baixa só o separador de vozes, e a pasta de modelos não contém o modelo de transcrição

### Requirement: Gravações longas e limites do provedor

O app MUST aceitar gravações de até 2 horas (64 MiB) com provedor de nuvem, dividindo o áudio em pedaços que respeitem o limite de tamanho do provedor (menos de 25 MB na Groq) sem perder nem duplicar falas nas emendas. Ao receber 429, o app MUST esperar o tempo de `retry-after` quando ele couber no prazo da transcrição. Se não couber, a tentativa na nuvem MUST ser tratada como falha de cota.

#### Scenario: Gravação de 2 horas pela Groq

- **WHEN** o usuário transcreve uma gravação de 2 horas pela Groq dentro da cota
- **THEN** a transcrição cobre a gravação inteira com tempos contínuos até o fim e sem trechos repetidos nas emendas

#### Scenario: Limite por minuto

- **WHEN** a Groq responde 429 com `retry-after` de poucos segundos
- **THEN** o app espera e continua, e a transcrição termina pela Groq

### Requirement: Fallback para o modelo local

Se a tentativa na nuvem falhar (sem rede, cota esgotada, chave recusada, erro do servidor ou prazo esgotado) e o modelo local estiver instalado, o app MUST transcrever a gravação localmente. O app MUST avisar que usou o modelo local e por quê, e o `.transcript.json` MUST registrar o fallback e o motivo. Sem o modelo local, o app MUST mostrar o erro do provedor com a ação "Tentar de novo", sem sugerir instalar o modelo local como se fosse a causa.

#### Scenario: Sem internet com modelo local

- **WHEN** a Groq está selecionada, o Mac está offline e o modelo local está instalado
- **THEN** a gravação é transcrita localmente e o app avisa "Transcrita neste Mac: Groq indisponível (sem conexão)"

#### Scenario: Cota esgotada sem modelo local

- **WHEN** a cota da Groq está esgotada e o modelo local não está instalado
- **THEN** o app mostra que a Groq recusou por cota, com "Tentar de novo", e a gravação continua salva

#### Scenario: Chave revogada

- **WHEN** a chave salva passa a ser recusada pelo provedor
- **THEN** a transcrição cai no modelo local se instalado, e a seção de Reunião passa a mostrar que a chave foi recusada

### Requirement: Avisos e ações coerentes com o provedor

O aviso "Instale a transcrição local" MUST aparecer só com o provedor Local selecionado e o modelo não instalado. Com um provedor de nuvem selecionado sem configuração válida, o app MUST mostrar um aviso que leva à seção de Reunião. A ação "Transcrever" do Drive MUST ficar disponível sempre que o provedor selecionado estiver pronto.

#### Scenario: Groq pronta sem modelo local

- **WHEN** a Groq está configurada, o modelo local não está instalado e o usuário salva uma gravação
- **THEN** nenhum aviso de instalar o modelo local aparece, e "Transcrever" fica disponível no Drive
