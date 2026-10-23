# Proposta

## Por quê

Hoje, para pedir algo ao agente sobre o que está na tela, o dono precisa abrir o Comma, escrever ou colar um print e explicar onde olhar. O Comma já tem agente, sidebar sobre outros apps, transcrição (Parakeet local, Groq ou API compatível) e upload de imagem no chat. Falta o gesto que junta tudo: segurar um atalho em qualquer app, falar e o agente já saber o que é "isso aqui", como no Clicky/OpenClicky.

## O que muda

- **Falar com o agente segurando um atalho**, em qualquer app e com a janela principal fechada:
  - um atalho global próprio (tecla + modificador, padrão `⌃⌥Espaço`), separado do atalho que abre a sidebar;
  - enquanto o atalho está pressionado, o microfone grava; ao soltar, a gravação termina;
  - gravações curtas demais (abaixo de 0,3 s) são descartadas sem enviar nada.
- **"Isso aqui" vira imagem**: ao apertar o atalho, o Comma tira um print do monitor onde está o cursor e guarda a posição do cursor. Com o atalho pressionado, arrastar o mouse marca uma área. Seguem junto com a pergunta o print do monitor, um recorte ampliado da área (ou da vizinhança do cursor), as coordenadas e o nome do app que estava em primeiro plano.
- **Transcrição pelo mecanismo já escolhido** em Ajustes → Reunião (Local, Groq ou API compatível com OpenAI), com o mesmo fallback para o modelo local.
- **A pergunta vai para o agente pela sidebar**: texto transcrito + print anexado (pelo upload de arquivos do chat que já existe) + descrição do ponto ou da área marcada. A sidebar abre mostrando a conversa.
- **Resposta falada**: quando o agente termina de responder, o texto aparece na sidebar e é lido em voz alta com a voz do sistema. Apertar o atalho de novo interrompe a leitura.
- **Estado visível**: enquanto o atalho está pressionado, uma pílula discreta perto do cursor mostra "Ouvindo"; depois de soltar, "Transcrevendo"; com a pergunta enviada, a sidebar abre e mostra o agente pensando, como já faz. Erros (sem permissão, transcrição indisponível, nada entendido) aparecem na pílula.
- **Ajustes**: ligar/desligar a função, escolher o atalho, ligar/desligar a resposta falada, enviar ou não o print.
- **Permissão de Gravação de Tela** pedida para o próprio Comma, só quando o envio do print está ligado. Sem a permissão, a pergunta segue só com o texto e o app avisa.

Fora do escopo: chamada de voz contínua (`VoiceCallControl`) com fim de fala e interrupção — depende do protocolo da assinatura ChatGPT, que não está documentado; atalho só de modificadores (exigiria Monitoramento de Entrada); o agente apontar ou desenhar na tela; estados no notch; voz de resposta por provedor pago; Windows e Linux. A função usa o agente do workspace ativo, em modo local ou remoto, sem tratamento especial para cada um além da transcrição.

## Capacidades

### Novas capacidades

- `agent-push-to-talk`: conversa com o agente segurando um atalho global — gravação, captura do contexto da tela (print, ponto, área), transcrição, envio à sidebar, resposta falada, estados, permissões e ajustes.

### Capacidades modificadas

Nenhuma. A transcrição reutiliza `meeting-transcription-providers` (change `add-cloud-meeting-asr`, ainda aberta) sem mudar seus requisitos.

## Impacto

- **Helper da sidebar** (`clients/apps/electron/native/macos/SideChatHost`): segundo atalho global com eventos de apertar e soltar e o app em primeiro plano; novos frames no contrato (`clients/packages/chat-contract`, Swift gerado).
- **Electron main**: orquestração do turno (gravação com o `MicCaptureHost`, captura com `desktopCapturer`, transcrição pelo helper local ou pela rota do backend, envio pelo coordenador de chat), janela transparente de marcação com a pílula de estado, leitura em voz alta com `say`, ajustes persistidos, texto de uso da Gravação de Tela.
- **Interface** (`clients/packages/app`): tela da sobreposição (marcação e pílula), seção de ajustes, textos em `en`, `pt-BR` e `zh-CN`.
- **Backend**: nenhuma mudança; usa o upload `POST /v1/comma/groups/:group_id/files` e o chat existentes. O modelo do agente precisa aceitar imagem (ou ter um descritor de imagem configurado) para usar o print; sem isso o agente recebe o texto e a referência ao arquivo.
- **Privacidade**: o print vai para o workspace do agente e, a partir dele, para o provedor do modelo do agente; o áudio vai para o mecanismo de transcrição escolhido. Os Ajustes deixam isso explícito.
