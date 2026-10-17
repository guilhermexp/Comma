# Spec Delta

## Purpose

Faz o app de desktop do Comma para macOS funcionar sozinho em qualquer Mac Apple silicon: o app leva o backend dentro do pacote, sobe, supervisiona, atualiza e encerra esse backend, e guarda os dados na máquina do usuário.

## ADDED Requirements

### Requirement: Pacote autossuficiente

O app de release para macOS arm64 SHALL levar dentro do pacote tudo o que o backend local precisa para rodar (backend, runtime, banco de dados, cache e armazenamento de arquivos). Nenhum binário do pacote SHALL carregar biblioteca dinâmica de fora do próprio app ou do sistema (`/System` e `/usr/lib`). O app SHALL funcionar num Mac sem Homebrew, sem Docker e sem nenhuma ferramenta de desenvolvimento.

#### Scenario: Mac limpo

- **WHEN** o usuário instala o DMG num Mac Apple silicon sem Homebrew nem Xcode e abre o app pela primeira vez
- **THEN** o app chega à tela inicial já conectado ao backend local, sem pedir nenhuma configuração

#### Scenario: Biblioteca fora do pacote

- **WHEN** o build de release encontra um binário do pacote que referencia uma biblioteca fora do app e fora do sistema
- **THEN** o build falha e não publica a release

### Requirement: Inicialização do backend local

Ao abrir, o app SHALL subir o backend local, preparar o banco (criação na primeira vez, migrações nas seguintes) e só mostrar a interface conectada quando o backend responder como pronto. Enquanto isso, o app SHALL mostrar uma tela de inicialização. Na primeira abertura, o app SHALL gerar os segredos da instalação; nenhum segredo fixo SHALL vir dentro do pacote.

#### Scenario: Primeira abertura

- **WHEN** o usuário abre o app pela primeira vez
- **THEN** o app cria os dados da instalação, gera segredos próprios, prepara o banco e abre a interface conectada

#### Scenario: Abertura seguinte

- **WHEN** o usuário abre o app de novo
- **THEN** o app reaproveita os dados e segredos existentes e abre a interface com as conversas, tarefas e configurações de antes

#### Scenario: Falha ao iniciar

- **WHEN** o backend local não fica pronto dentro do tempo limite
- **THEN** o app mostra um erro com a causa resumida, uma ação para tentar de novo e o caminho do log, sem apagar dados

### Requirement: Acesso só pela própria máquina

Todos os serviços do backend local SHALL aceitar conexões apenas no endereço de loopback (`127.0.0.1`). Se uma porta escolhida estiver ocupada, o app SHALL escolher outra livre em vez de falhar ou de se conectar a um serviço de outra origem.

#### Scenario: Acesso pela rede

- **WHEN** outro computador da mesma rede tenta acessar a porta do backend local
- **THEN** a conexão é recusada

#### Scenario: Porta ocupada

- **WHEN** a porta usada antes está ocupada por outro programa ao abrir o app
- **THEN** o app usa outra porta livre e a interface funciona normalmente

#### Scenario: Ambiente de desenvolvimento rodando

- **WHEN** o backend de desenvolvimento do dono já está rodando no mesmo Mac
- **THEN** o app de release sobe o próprio backend com os próprios dados e não lê nem altera os dados do ambiente de desenvolvimento

### Requirement: Supervisão e encerramento

O app SHALL reiniciar um processo do backend local que pare sozinho, com espera crescente entre tentativas. Depois de falhas repetidas, o app SHALL parar de tentar e mostrar o erro. Ao fechar o app, todos os processos do backend local SHALL ser encerrados de forma limpa e nenhum SHALL continuar rodando.

#### Scenario: Processo cai

- **WHEN** um processo do backend local termina sozinho enquanto o app está aberto
- **THEN** o app o reinicia e a interface volta a funcionar sem o usuário fechar o app

#### Scenario: Fechar o app

- **WHEN** o usuário fecha o app
- **THEN** o banco é encerrado sem perda de dados e nenhum processo do backend local fica rodando

#### Scenario: App fechado à força

- **WHEN** o app foi encerrado à força e é aberto de novo
- **THEN** o app encerra processos que ficaram da sessão anterior antes de subir os novos e abre normalmente

### Requirement: Dados do usuário e atualizações

Os dados do backend local SHALL ficar na pasta de dados do app do usuário, separados de qualquer ambiente de desenvolvimento, e SHALL sobreviver às atualizações do app. Antes de migrar o banco para uma versão nova do app, o app SHALL guardar um backup do banco, mantendo os mais recentes.

#### Scenario: Atualização do app

- **WHEN** o app se atualiza para uma versão com migrações novas e é aberto
- **THEN** o app guarda um backup do banco, aplica as migrações e abre a interface com os dados de antes

#### Scenario: Migração falha

- **WHEN** uma migração falha ao abrir uma versão nova
- **THEN** o app mostra o erro, informa onde está o backup e não abre a interface com o banco num estado parcial
