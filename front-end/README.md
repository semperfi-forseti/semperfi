# SEMPER-FI · Frontend

Central jurídica operacional da FORSETI Technologies. Interface em português, tema escuro, acentos ciano/dourado e módulos de gestão, investigação e evidências. HTML5, CSS com custom properties e JavaScript vanilla; sem framework ou compilação.

## Estado atual

- Login e cadastro para pessoa física (PF) ou jurídica (PJ), com senha e confirmação por código enviado ao e-mail. O acesso institucional OIDC é uma alternativa de configuração.
- A página pública apresenta recursos, orientações de cadastro, planos e perguntas frequentes antes do login, com navegação por seções e atalhos para os formulários.
- Inicialização **sem clientes, processos, investigações, históricos ou saldos fictícios**. O painel aparece somente após verificar a sessão e carregar `/v1/frontend/bootstrap`.
- Cadastros principais usam a API. Módulos avançados ainda têm integrações parciais, discriminadas abaixo.
- **Plano & Consumo** incorpora o catálogo do arquivo de referência `semperfi.html`: cinco planos, adicionais, pacotes de créditos, opções de recarga e tabela de operações. Comparação e resumos são interativos; contratação, assinatura e carteiras continuam indisponíveis até a integração comercial.
- O frontend salva apenas preferências visuais no `localStorage`. Senhas, tokens de provedor e registros operacionais não são persistidos nele.

## Requisitos para executar

| Requisito | Finalidade |
| --- | --- |
| Node.js 22 ou 24 e npm | Servidor local, verificações e sincronização; validado com Node 24 |
| Backend em `127.0.0.1:8000` | Autenticação, leitura e persistência |
| Navegador moderno | `fetch`, Web Crypto, cookies, `inert`, `AbortSignal.timeout`, Grid/Flex |
| HTTP local ou HTTPS | Abertura por `file://` não é suportada |
| Docker com Compose, opcional | Entrega via Nginx |

Requisitos Python e infraestrutura: [README do backend](../back-end/README.md).

## Executar localmente

Inicie primeiro o backend conforme seu README. Em outro terminal, partindo da raiz do projeto:

```powershell
cd front-end
npm ci
npm run dev
```

Abra `http://127.0.0.1:4173`. Sem sessão, será exibida a tela com **Entrar** e **Criar conta**. Use `AUTH_MODE=password` no backend. O acesso técnico permanece recolhido e aparece somente se o servidor habilitar expressamente o modo de desenvolvimento.

O `server.mjs` e seu proxy `/v1/*` para `127.0.0.1:8000` foram preservados. Para outra porta do frontend:

```powershell
$env:PORT = "4174"
npm run dev
```

### Servir a interface pela API

```powershell
npm run sync:backend
```

Depois abra `http://127.0.0.1:8000/`. A API redireciona para `/ui/frontend/index.html`, preservando os caminhos relativos de assets, login e dados.

**Edite sempre em `front-end/`.** A pasta `back-end/app/static/frontend/` é a distribuição gerada. Sincronize após mudanças; `npm run check` detecta divergências. A cópia inclui somente HTML, assets, catálogos e atalhos, sem documentação ou servidor Node na pasta pública.

### Docker

```powershell
docker compose up --build
```

Abra `http://localhost:8088`. O Nginx encaminha `/v1` para `host.docker.internal:8000`. A API no host precisa aceitar conexões da rede Docker, por exemplo com `--host 0.0.0.0` em ambiente local controlado. Para implantação remota, configure o upstream em `nginx.conf` e TLS no gateway.

### Hospedagem

A interface exige a API em execução: publicar somente HTML/CSS/JS não permite autenticar ou salvar cadastros. Mantenha os assets e `/v1/*` na mesma origem pública, servindo a distribuição pela API ou configurando um proxy reverso. A tela de login usa caminhos `/v1` e cookies da mesma origem; configurar apenas CORS não adapta a interface para uma API em outro domínio.

O `server.mjs` atende apenas em `127.0.0.1` e destina-se ao desenvolvimento local. O Nginx fornecido atende HTTP e usa um upstream local; ajuste domínio, upstream, HTTPS e limite de corpo das requisições no gateway. Para uploads da API, esse limite deve comportar `MAX_UPLOAD_BYTES` mais o envelope multipart. O `nginx.conf` atual não configura esse limite.

No backend, use `ENVIRONMENT=production`, migrations aplicadas, Redis disponível e credenciais próprias. O cookie recebe `Secure` nesse ambiente e depende de HTTPS. Requisitos de banco, filas, cofre e limites de implantação estão no [README do backend](../back-end/README.md#hospedagem-e-operação).

## Login e conta

1. `auth.js` consulta `GET /v1/auth/status`, sem criar uma sessão automaticamente. Uma verificação pendente é retomada após recarregar a página.
2. Escolha **Pessoa física** para atuação individual ou **Pessoa jurídica** para um escritório/sociedade. No cadastro PJ, informe também o nome da pessoa jurídica e o nome do responsável. Ambos os tipos usam e-mail e senha; a conta PJ é acessada pela pessoa responsável vinculada ao escritório.
3. **Entrar** envia os dados a `POST /v1/auth/login`; **Criar conta**, a `POST /v1/auth/register`. A senha exige de 12 a 128 caracteres, com confirmação no cadastro. Essas etapas iniciam um desafio e **não liberam sessão**.
4. Informe o código de seis dígitos recebido por e-mail em `POST /v1/auth/verify`. Somente após essa confirmação o cadastro cria usuário, espaço separado e vínculo de administrador, ou o login abre a sessão. Não há registros jurídicos de exemplo.
5. O código vale por dez minutos, com até cinco tentativas, por padrão. **Reenviar código** respeita um intervalo de sessenta segundos e invalida o código anterior. Após a expiração, **Iniciar novamente** retorna aos dados de acesso para solicitar outro desafio. **Usar outros dados** cancela a verificação. O servidor aplica os limites; o contador da interface é informativo.
6. O envio exige SMTP configurado no [backend](../back-end/README.md#envio-do-código-por-e-mail). Sem serviço de envio, o sistema informa indisponibilidade. Nenhum código é mostrado como alternativa no painel, nos logs ou no navegador. SMS ainda não foi integrado.
7. `ALLOW_SELF_REGISTRATION=false` fecha novos cadastros. Informar o nome de um escritório existente não cria vínculo com ele. Convites e gestão de membros ainda não têm fluxo na UI; clientes jurídicos PF/PJ do módulo Clientes não recebem uma conta de acesso automaticamente.
8. `AUTH_MODE` seleciona `password`, `oidc` ou `development`. Em OIDC, o provedor cuida da entrada/MFA; a verificação por e-mail descrita aqui pertence ao modo de senha.
9. O painel aguarda a sessão autenticada e o bootstrap. Uma resposta 401 leva ao login; **Sair da conta** revoga a sessão no servidor.

Cookies de desafio e sessão são HttpOnly e Secure em produção. A interface não salva senha ou código em `localStorage`/`sessionStorage`. Não há recuperação automática de senha nesta versão. Nome, e-mail e permissões vêm da sessão e não podem ser alterados localmente para obter privilégios.

O rodapé institucional permanece no fluxo da página, acessível por rolagem, com atalhos para entrar, cadastrar, abrir ajuda e voltar ao topo. Os atalhos movem o foco de teclado e respeitam movimento reduzido. Durante uma verificação, voltar aos formulários cancela o desafio anterior.

## Arquivos e responsabilidades

| Arquivo/pasta | Manter para |
| --- | --- |
| `index.html` | Estrutura do painel, menus, modal e guarda inicial de sessão |
| `login.html` | Apresentação pública, planos, dúvidas, formulários de entrada/cadastro, ajuda e rodapé institucional |
| `assets/css/style.css` | Componentes e estilos existentes |
| `assets/css/interface.css` | Identidade atualizada, login, responsividade, foco e movimento reduzido |
| `assets/css/commercial.css` | Catálogo comercial, seletores e modais responsivos |
| `assets/css/public.css` | Apresentação pública, navegação, recursos e comparação de planos antes do login |
| `assets/js/auth.js` | Sessão, entrada, redirecionamento e saída |
| `assets/js/app.js` | Cliente `/v1`, estado em memória, módulos e formulários |
| `assets/js/interface.js` | Teclado, menu móvel, histórico e apresentação |
| `assets/js/commercial.js` | Carregamento do catálogo e comparação/seleção comercial, sem gravar compras ou alterar saldos |
| `assets/js/public.js` | Catálogo público, resumo de planos, âncoras e indicação da seção visível |
| `data/sources.json` | Catálogo de fontes; não contém resultados ou pessoas fictícias |
| `data/commercial.json` | Planos, preços, franquias, adicionais, pacotes e operações trazidos da referência fornecida |
| `pages/*.html` | 21 atalhos por módulo, mantidos para compatibilidade de links |
| `server.mjs` | Servidor local e proxy da API |
| `scripts/check.mjs` | Sintaxe JS/JSON, UTF-8, sinais de mojibake e charset HTML |
| `scripts/sync-backend.mjs` | Geração e verificação da distribuição da API |
| `tests/empty-state.test.cjs` | Regressões contra dados pré-carregados e armazenamento antigo |
| `tests/browser-helpers.test.cjs` | Datas no fuso local e término da análise de imagens válidas, inválidas ou lentas |
| `package.json`, `package-lock.json` | Comandos e instalação reproduzível |
| `Dockerfile`, `docker-compose.yml`, `nginx.conf` | Entrega opcional via Nginx |
| `.gitignore`, `.dockerignore` | Exclusão de dependências e arquivos locais dos artefatos |
| `README.md` | Referência de execução, requisitos e manutenção |

Removidos: `app.js`/`style.css` duplicados na raiz e `config/frontend.config.json`, que não era lido e indicava modo demo. Os guias antigos do frontend foram consolidados neste README. A API mantém somente a distribuição necessária para servir a interface.

## Requisitos funcionais

**Integrado** significa que existe fluxo no código; não implica homologação com serviços externos reais.

| ID | Requisito | Situação |
| --- | --- | --- |
| RF-F01 | Cadastrar/entrar como PF ou PJ, verificar código, sair e tratar expiração | Senha + código por e-mail; cadastro configurável; SMTP necessário; OIDC exige provedor |
| RF-F02 | Navegar por âncoras, atalhos e histórico | Implementado, 21 módulos |
| RF-F03 | Painel calculado a partir dos registros | Implementado; início vazio |
| RF-F04 | Criar, consultar, editar e excluir clientes | Cadastro principal integrado a `/v1/clients`; dados complementares do perfil 360° indisponíveis para alteração |
| RF-F05 | Manter processos e andamentos | Cadastro principal e andamentos integrados; vínculos de arquivos indisponíveis na tela de análise local |
| RF-F06 | Manter agenda, prazos e intimações | Operações individuais integradas; criação conjunta de andamento, prazo e compromisso bloqueada |
| RF-F07 | Manter receitas e despesas jurídicas | Integrado; não efetua pagamentos |
| RF-F08 | Buscar registros e mascarar documentos | Implementado; mascaramento visual não substitui autorização |
| RF-F09 | Gerir investigações, entidades e achados; consultar relações | Integração parcial; checklists TACER e matriz ACH da UI são rascunhos temporários |
| RF-F10 | Executar conectores autorizados | Parcial; depende de fonte, credenciais e filas |
| RF-F11 | Enviar e preservar evidências | Fluxo no workspace de investigação; depende de tipos MIME autorizados, ingestão e cofre. A tela Arquivos oferece inspeção local temporária |
| RF-F12 | Consultar/gerar relatórios | Exportações locais e API coexistem; aprovação/cofre precisam de homologação |
| RF-F13 | Consultar auditoria | Eventos do bootstrap e eventos locais da sessão; a verificação na API cobre sua própria cadeia persistida |
| RF-F14 | Importar clientes/processos de JSON | Integrado a `/v1/imports/frontend-demo`; nome histórico da rota preservado |
| RF-F15 | Exibir conta e salvar preferências | Conta somente leitura; preferências visuais locais |
| RF-F16 | Explorar OSINT, radar, APIs e referências | Parcial; catálogo não garante execução ou disponibilidade de cada serviço |
| RF-F17 | Calculadoras com entradas do operador | Estimativas; calendário/fórmulas exigem validação específica |
| RF-F18 | Plano & Consumo | Catálogo, comparação de cinco planos, cálculo de adicionais e resumos de pacotes; contratação e carteiras indisponíveis |
| RF-F19 | Transparência Pública | Catálogo; esta tela não executa consultas nem solicita token |
| RF-F20 | Agentes IA | Ferramentas determinísticas e consultas parciais; resultados temporários, sem registro em investigação nem provedor LLM configurado |
| RF-F21 | Informações antes do login | Recursos, cadastro PF/PJ, etapas de acesso, catálogo de planos e oito perguntas frequentes; sem exigir sessão |

Identificadores das seções: `dashboard`, `clients`, `processes`, `agenda`, `deadlines`, `intimations`, `financial`, `billing`, `queries`, `osint`, `osinttools`, `agentes`, `societario`, `transparencia`, `apiexplorer`, `conhecimento`, `metadata`, `calculators`, `reports`, `audit`, `settings`.

### Catálogo comercial

Na página pública `login.html`, a navegação oferece **Recursos**, **Como começar**, **Planos** e **Dúvidas**. Os cinco planos usam o mesmo JSON da área interna. **Conhecer este plano** mostra um resumo e o atalho **Ir para cadastro** abre o formulário existente. Essa consulta não vincula um plano ao cadastro e não é gravada. Os formulários permanecem disponíveis se o catálogo falhar; o catálogo continua acessível se a API de autenticação estiver indisponível.

Abra **Plano & Consumo** no menu ou no atalho do cabeçalho. **Ver planos** compara Lite, Profissional, Escritório, Equipe e Corporate em um modal com rolagem, fechamento por Escape e navegação por teclado. O plano Profissional recebe apenas um destaque de apresentação; nenhum plano é indicado como contratado.

Os valores e limites estão em `data/commercial.json`, extraídos do `semperfi.html` fornecido na raiz. Altere esse JSON para revisar o catálogo e execute `npm run sync:backend`. O HTML de referência não é carregado nem distribuído pela aplicação.

Adicionais aceitam quantidades inteiras de zero a cem e mostram o subtotal mensal. Pacotes de créditos e opções de recarga permitem consultar um resumo. Essas seleções são temporárias: não geram pedidos, pagamentos, créditos, limites contratados ou lançamentos financeiros. Corporate mostra os detalhes para uma futura proposta; o contato comercial ainda precisa ser configurado.

No painel, o catálogo é carregado apenas ao abrir a seção; na página pública, carrega junto à apresentação. Ambos oferecem estado de carregamento, tratamento de falha e nova tentativa. Uma falha nesse arquivo não impede o acesso aos demais módulos. A tabela de operações descreve os custos previstos na referência; não executa serviços nem debita créditos. Os históricos permanecem sem registros comerciais.

Para ativar contratação, ainda será necessário implementar no backend o ciclo de assinatura, pedidos/pagamentos, confirmação do provedor e carteiras persistentes, com autorização no servidor. O endpoint `/v1/financial-entries` atende ao financeiro jurídico e não é usado como checkout.

### Limites dos dados complementares

- Biografia, histórico político, patrimônio, empresas, notícias e documentos do perfil 360° continuam disponíveis para consulta. As ações de alteração avisam que estão indisponíveis e não gravam nem removem registros.
- O lançamento conjunto de intimação está bloqueado. Cadastre andamento, prazo e compromisso separadamente nas telas integradas.
- A tela **Metadados e Arquivos** calcula hash, tamanho, tipo informado e dimensões de imagens compatíveis no navegador. Não envia arquivos, não extrai EXIF completo, não cria cadeia de custódia e não salva vínculos. Suas análises desaparecem ao recarregar.
- As marcações TACER, hipóteses e matriz ACH são rascunhos temporários. Elas não executam nem persistem resultados dos motores TACER/SIERA existentes na API.
- Resultados da seção **Agentes IA** ficam temporariamente na página. Registrar consultas públicas no dossiê também permanece indisponível.

O fluxo de evidências do workspace OSINT envia conteúdo textual/JSON à API. A configuração padrão de `ALLOWED_MIME_TYPES` autoriza PDF, imagens e vídeos: texto/JSON será rejeitado enquanto essa lista não for alinhada aos formatos que a organização autorizar. A inspeção local de arquivos não substitui esse fluxo de ingestão e preservação.

## Requisitos não funcionais

| ID | Requisito | Implementação/limite |
| --- | --- | --- |
| RNF-F01 | Identidade e português UTF-8 | Base `#07111f`, ciano/dourado, charset e verificação automatizada |
| RNF-F02 | Responsividade | Grid/Flex, menu móvel e tabelas roláveis. Login com rolagem do documento e rodapé após o conteúdo, inclusive em telas estreitas e baixas |
| RNF-F03 | Navegação por teclado | Foco visível, Escape, contenção/retorno de foco e link de salto |
| RNF-F04 | Movimento reduzido | `prefers-reduced-motion`; conteúdo independe de animação |
| RNF-F05 | Tratamento de falhas | Mensagens de conexão, timeout, estados vazios e sessão expirada |
| RNF-F06 | Segredos fora do frontend | Cookie HttpOnly e credenciais de conectores no backend |
| RNF-F07 | Consistência da distribuição | Fonte única e sincronização verificada |
| RNF-F08 | Manutenibilidade | Sessão/interação separadas; módulo operacional ainda deve ser dividido gradualmente |
| RNF-F09 | Acessibilidade/contraste | Melhorias aplicadas; auditoria WCAG AA completa permanece pendente |
| RNF-F10 | Desempenho | Sem framework/build; grandes listas precisam de paginação e teste de carga |
| RNF-F11 | Segurança de conteúdo | Interpolações e handlers HTML legados ainda exigem revisão antes de produção |

## Dados reais de teste

Use uma base de homologação dedicada. Cadastre o primeiro cliente, depois seu processo, prazos e compromissos. Recarregue a página para conferir a persistência na API. Configure ingestão/cofre antes dos testes de anexos.

O frontend não lê mais `semperfi_db_v1`. Dados antigos do navegador não são importados nem apagados automaticamente. Um banco existente também não é esvaziado. Fixtures e `back-end/examples/` não são carregados no painel. O cadastro de conta cria apenas a identidade, organização e vínculo, sem clientes/processos de exemplo.

A importação adiciona clientes/processos; não restaura todas as coleções do backup. A exportação do navegador contém o estado carregado, inclusive eventuais rascunhos temporários, e não substitui backup do banco e do cofre. Importar esse JSON não restaura os rascunhos, as evidências ou os arquivos originais.

## Verificar e desenvolver

```powershell
npm run sync:backend
npm run check
npm test
```

Novo módulo: registre em `SECTIONS`, implemente `SECTION_RENDERERS` e, se preciso, `SECTION_AFTER`; conecte mutações a `/v1`; adicione atalho e documentação. Não introduza dados fictícios como fallback de falha.

Antes de produção, homologue o modo de autenticação escolhido, isolamento de organização, anexos, relatórios, segurança e conectores com a infraestrutura real. Testes locais não são certificação de produção.
