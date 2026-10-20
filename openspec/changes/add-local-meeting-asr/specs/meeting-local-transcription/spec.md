# Spec Delta

## Purpose

Transcrever no próprio Mac as gravações de reunião feitas pelo app desktop, identificando quem fala, com um modelo de reconhecimento de fala que o usuário instala e remove pelo app, sem enviar o áudio para fora da máquina.

## ADDED Requirements

### Requirement: Disponibilidade por plataforma

O app MUST oferecer a transcrição local somente em Mac com Apple Silicon e macOS 15 ou mais novo, com o app rodando seu backend local. Em outro ambiente, a seção de transcrição local MUST aparecer como indisponível, com o motivo, e sem botão de instalar.

#### Scenario: Mac compatível

- **WHEN** o usuário abre Ajustes → Trabalho → Reunião num Mac Apple Silicon com macOS 15+ e backend local
- **THEN** a seção "Transcrição local" mostra o estado do modelo e as ações disponíveis

#### Scenario: Mac incompatível

- **WHEN** o usuário abre a mesma seção num Mac Intel ou com macOS 14
- **THEN** a seção informa que a transcrição local exige Apple Silicon e macOS 15+, e não oferece instalação

### Requirement: Modelo fora do pacote do app

O pacote do app MUST NOT conter os pesos do modelo de transcrição nem do separador de vozes. Eles MUST ser obtidos somente por ação explícita do usuário.

#### Scenario: App recém-instalado

- **WHEN** o usuário instala o app e nunca clicou em Instalar
- **THEN** nenhum peso de modelo existe no disco e a seção mostra "Não instalado" com o tamanho aproximado do download

### Requirement: Instalação verificada com progresso

Ao clicar em Instalar, o app MUST baixar a versão fixada do modelo de transcrição e do separador de vozes, mostrar o progresso em porcentagem, conferir o SHA-256 e o tamanho de cada arquivo contra um manifesto embutido no app, preparar o modelo para execução e só então marcar o estado como pronto. Um arquivo divergente MUST invalidar a instalação inteira. Uma instalação interrompida MUST NOT deixar o modelo marcado como pronto.

#### Scenario: Instalação bem-sucedida

- **WHEN** o usuário clica em Instalar com internet disponível
- **THEN** o estado passa por "Baixando N%", depois "Preparando" e termina em "Pronto"

#### Scenario: Arquivo corrompido

- **WHEN** um arquivo baixado tem SHA-256 ou tamanho diferente do manifesto
- **THEN** o app descarta os arquivos baixados, mostra erro com a opção de tentar de novo e o estado não fica "Pronto"

#### Scenario: Interrupção

- **WHEN** a rede cai ou o app é fechado durante o download
- **THEN** na próxima abertura o estado é "Não instalado" (ou erro com tentar de novo) e nenhum arquivo parcial é usado

### Requirement: Remoção libera o espaço

Com o modelo instalado, o app MUST oferecer Remover. Remover MUST apagar os arquivos do modelo e do separador de vozes e voltar o estado para "Não instalado". Remover MUST NOT ser aceito enquanto uma transcrição estiver em andamento.

#### Scenario: Remover

- **WHEN** o usuário clica em Remover sem transcrição em andamento
- **THEN** a pasta do modelo deixa de existir e a seção mostra "Não instalado"

#### Scenario: Remover durante transcrição

- **WHEN** o usuário tenta remover enquanto uma gravação está sendo transcrita
- **THEN** o app recusa e explica que há uma transcrição em andamento

### Requirement: Transcrição local da gravação com quem fala

Com o modelo pronto, ao parar uma gravação de reunião, o app MUST transcrevê-la no próprio Mac, sem enviar o áudio a serviços externos, e gravar ao lado da gravação o `.transcript.txt` e o `.transcript.json`. O texto MUST ter uma linha por trecho de fala, no formato `[HH:MM:SS] Speaker N: texto`, com tempo relativo ao início da gravação e o mesmo número de speaker para a mesma voz ao longo de toda a gravação. Gravações de até 2 horas (até 64 MiB) MUST ser aceitas.

#### Scenario: Chamada com duas pessoas

- **WHEN** o usuário grava uma chamada de 10 minutos com duas vozes e para a gravação
- **THEN** o `.transcript.txt` tem linhas `[HH:MM:SS] Speaker 1: …` e `[HH:MM:SS] Speaker 2: …` em ordem de tempo, no idioma falado

#### Scenario: Gravação longa

- **WHEN** a gravação tem 2 horas
- **THEN** a transcrição é aceita e concluída, com tempos coerentes até o fim da gravação

#### Scenario: Sem fala

- **WHEN** a gravação não tem fala
- **THEN** a transcrição termina sem erro e com texto vazio

#### Scenario: Resumo inteligente

- **WHEN** o resumo inteligente está ligado e a gravação termina
- **THEN** a transcrição usada pela tarefa de resumo vem do mesmo modelo local

### Requirement: Comportamento sem modelo instalado

Sem o modelo pronto, a gravação MUST ser salva normalmente, e o app MUST avisar que a transcrição local não está instalada, com uma ação que leva à instalação. Depois de instalar, o usuário MUST conseguir pedir a transcrição de uma gravação já salva que não tem transcrição ou cuja transcrição falhou.

#### Scenario: Gravação sem modelo

- **WHEN** o usuário para uma gravação com o modelo não instalado
- **THEN** a gravação aparece salva e o app mostra "Instale a transcrição local" com o botão de instalar, sem erro genérico de servidor

#### Scenario: Transcrever depois

- **WHEN** o usuário instala o modelo e pede para transcrever uma gravação antiga
- **THEN** o app gera o `.transcript.txt` e o `.transcript.json` dessa gravação

### Requirement: Uso leve de recursos

A transcrição local MUST rodar com prioridade baixa de CPU e E/S. O modelo MUST ser carregado só durante um trabalho de transcrição e liberado ao fim dele. O app MUST executar no máximo uma transcrição local por vez, enfileirando as demais.

#### Scenario: Ociosidade

- **WHEN** nenhuma transcrição está em andamento
- **THEN** o processo de transcrição local não mantém o modelo carregado

#### Scenario: Duas gravações seguidas

- **WHEN** duas gravações terminam quase ao mesmo tempo
- **THEN** elas são transcritas uma depois da outra e ambas recebem transcrição

### Requirement: Acesso só da própria máquina

O serviço local de transcrição MUST aceitar conexões apenas em `127.0.0.1` e MUST exigir um token gerado na instalação do backend local. Uma requisição sem o token MUST ser recusada.

#### Scenario: Requisição sem token

- **WHEN** um processo local chama o serviço sem o token
- **THEN** o serviço responde 401 e não transcreve

#### Scenario: Acesso pela rede

- **WHEN** outro dispositivo da rede tenta conectar na porta do serviço
- **THEN** a conexão é recusada
