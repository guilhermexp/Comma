# Proposal

## Why

O DMG do Comma só funciona no Mac do dono, porque depende de um backend que ele sobe à mão (Postgres, Redis, MinIO e o backend Elixir em `127.0.0.1:4200`). Qualquer outra pessoa que instala o app cai em "O Comma não conseguiu se conectar". O app precisa funcionar sozinho em qualquer Mac, como um app de desktop normal: instalar, abrir e usar, sem servidor, sem cadastro e sem configuração.

## What Changes

- O app de release passa a levar o backend inteiro dentro do pacote: o backend Elixir compilado com o runtime do Erlang, Postgres 16, Redis e MinIO, todos nativos para macOS arm64 e sem depender de Homebrew nem de nada instalado na máquina.
- O app sobe esses processos ao abrir, roda as migrações, espera o backend ficar pronto e mostra uma tela de "iniciando" enquanto isso. Ao fechar o app, tudo para de forma limpa. Se um processo cair, o app tenta de novo e, se não conseguir, mostra um erro com o que fazer.
- Os dados (banco, arquivos, chaves) ficam em `~/Library/Application Support/Comma/local`, separados do ambiente de desenvolvimento, e sobrevivem às atualizações do app.
- No modo local não existe login: na primeira abertura o app cria o dono da instalação e entra direto. O backend só aceita conexões de `127.0.0.1`.
- Cada instalação gera os próprios segredos na primeira abertura (senhas do banco e do armazenamento, chaves do backend). Nada de segredo fixo vai dentro do app.
- Antes de migrar o banco numa versão nova do app, o app guarda um backup do banco.
- O build de release no GitHub Actions passa a gerar e empacotar esse backend, e ganha uma verificação de que nenhum binário do pacote aponta para bibliotecas fora do app.
- **BREAKING**: o app de release deixa de apontar para um backend fixo (`COMMA_API_BASE_URL`); ele usa o backend local que ele mesmo sobe. A variável do repositório deixa de ser usada pelo release.
- Fora do escopo: o modo cloud (escolher um backend remoto e entrar com e-mail), a tela de escolha de modo, AirDrop e Intel/x86_64. O fluxo de desenvolvimento (`pnpm dev:electron` contra o backend externo) continua igual.

## Capabilities

### New Capabilities

- `desktop-local-backend`: o app de desktop leva, sobe, supervisiona, atualiza e encerra o backend local que roda no próprio Mac, com os dados guardados na máquina do usuário.
- `desktop-local-owner-session`: no modo local, o app entra automaticamente como o único dono da instalação, sem login, com acesso restrito à própria máquina.

### Modified Capabilities

(nenhuma; o projeto ainda não tem specs canônicas)

## Impact

- **Electron** (`clients/apps/electron`): novo módulo no processo Main que gerencia os processos do backend local; tela de inicialização e de erro; a configuração de release passa a resolver a URL da API em tempo de execução no modo local; `startup-session.ts` hoje recusa sessão automática em app empacotado e passa a aceitar a sessão criada pelo modo local.
- **Backend** (`systems/`): `mix release comma` para macOS arm64 com as NIFs (verified kernel em Lean, libsodium, libopus, mdex) e o `spinfoam`; inicialização com `COMMA_ENVIRONMENT=local` reaproveitando `Comma.FreshInstall`; criação do dono e da sessão pelo caminho de admin que o seed local já usa.
- **Build e CI** (`clients/apps/electron/scripts/`, `.github/workflows/desktop-release.yml`): compilar o backend, obter Postgres/Redis/MinIO relocáveis, ajustar as bibliotecas dinâmicas para ficarem dentro do app, assinar tudo ad hoc e conferir que nada aponta para `/opt/homebrew` ou `/usr/local`.
- **Tamanho**: o DMG passa de cerca de 195 MB para algo entre 350 e 450 MB.
- **Documentação**: runbook de release e instruções de primeira instalação.
