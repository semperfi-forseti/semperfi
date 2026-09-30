# SEMPER-FI · Frontend

Central jurídica operacional da FORSETI Technologies. Interface em português, temas claro/escuro, acentos ciano/dourado e módulos de gestão, investigação e evidências. HTML5, CSS com custom properties e JavaScript vanilla; sem framework ou compilação.

## Estado atual

- Login e cadastro para pessoa física (PF) ou jurídica (PJ), com senha e confirmação por código enviado ao e-mail. O acesso institucional OIDC é uma alternativa de configuração.
- Recuperação de senha pelo link **Esqueci minha senha**, com código temporário por e-mail, confirmação da nova senha e invalidação das sessões anteriores.
- A página pública apresenta recursos, orientações de cadastro, planos e perguntas frequentes antes do login, com navegação por seções e atalhos para os formulários.
- Inicialização **sem clientes, processos, investigações, históricos ou saldos fictícios**. O painel aparece somente após verificar a sessão e carregar `/v1/frontend/bootstrap`.
- Cadastros principais usam a API. Módulos avançados ainda têm integrações parciais, discriminadas abaixo.
- **Plano & Consumo** incorpora o catálogo do arquivo de referência `semperfi.html`. O checkout mensal foi conectado ao **Asaas Sandbox**, mediante configuração do backend. Produção, adicionais, carteiras e créditos reais continuam indisponíveis.
- O frontend salva apenas preferências visuais no `localStorage`. Senhas, tokens de provedor e registros operacionais não são persistidos nele.

## Requisitos para executar

### Aparência e acessibilidade

No cabeçalho, **Modo claro/escuro** alterna a aparência e **Acessibilidade** abre as preferências. Também há acesso nos modais, no login, no rodapé público e em Configurações.

- Tema claro, escuro ou conforme o sistema; alto contraste em ambos.
- Fonte em 100%, 125%, 150% ou 200%; espaçamento de leitura e links sublinhados.
- Movimento reduzido e avisos persistentes. Falhas e alertas permanecem até serem fechados; a informação não depende de som.
- Labels de formulários, foco visível, navegação por teclado, Escape e retorno de foco; o painel de acessibilidade pode ser aberto durante outro modal.
- Preferências na chave local `semperfi_accessibility_v1`, sem dados da conta. A aplicação continua operável quando esse armazenamento é bloqueado.

Os testes automatizados e de navegador não substituem avaliação com leitores de tela, tecnologias assistivas e usuários com deficiência. Não há alegação de conformidade WCAG integral nem tradução automática de mídia para Libras/legendas.

### Módulos novos

| Arquivo | Responsabilidade |
| --- | --- |
| `accessibility.js`, `accessibility.css`, `themes.css` | Preferências, temas, contraste, fontes, foco e movimento |
| `legal-forms.js` | Validação nativa, envio único e compatibilidade cliente/processo |
| `connector-jobs.js` | Enfileirar, acompanhar e retomar uma consulta sem repetir o POST |
| `audit-view.js` | Eventos persistidos, filtros e verificação de cadeia |
| `billing-checkout.js` | Disponibilidade, pedido e checkout Asaas Sandbox |
| `integrations-view.js` | Transparência, agentes Ollama, arquivos e relatórios persistidos |
| `radar-view.js` | Consulta de CNPJ pela fila do backend e reabertura do histórico da organização |
| `calculators.js` | Quatro calculadoras técnicas com parâmetros fornecidos pelo operador |

As calculadoras não utilizam índices aproximados de IPCA/IGP-M/SELIC, juros fixos automáticos ou tabela penal presumida. Datas excluídas, fração, fator de atualização, juros e verbas são informados explicitamente. O resultado é aritmético; não determina elegibilidade jurídica nem substitui calendário oficial ou liquidação de sentença. São cálculos locais sem gravação, portanto não precisam enviar dados ao servidor.

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

Cookies de desafio e sessão são HttpOnly e Secure em produção. A interface não salva senha ou código em `localStorage`/`sessionStorage`. Nome, e-mail e permissões vêm da sessão e não podem ser alterados localmente para obter privilégios.

**Recuperação de senha:** escolha **Esqueci minha senha**, informe o e-mail e depois o código e a nova senha (12–128 caracteres, com confirmação). A solicitação recebe a mesma resposta para contas existentes e desconhecidas. O código está vinculado ao navegador, expira e possui limites de tentativas/reenvio. Após a troca, faça login novamente e confirme o 2FA; redefinir a senha não abre uma sessão. Sessões antigas são invalidadas. A atualização também exige um novo login, uma vez, para sessões por senha criadas antes da adoção da versão de credencial.

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
| RF-F01 | Cadastrar/entrar como PF ou PJ, recuperar senha, verificar código, sair e tratar expiração | Senha + código por e-mail; recuperação revoga sessões; SMTP necessário; OIDC exige provedor |
| RF-F02 | Navegar por âncoras, atalhos e histórico | Implementado, 21 módulos |
| RF-F03 | Painel calculado a partir dos registros | Implementado; início vazio |
| RF-F04 | Criar, consultar, editar e excluir clientes | Cadastro principal e perfil complementar persistidos; edição concorrente protegida por versão; documentos vinculados pela API |
| RF-F05 | Manter processos e andamentos | Cadastro, andamentos e vínculos de arquivos integrados; remover vínculo preserva o arquivo original |
| RF-F06 | Manter agenda, prazos e intimações | Operações individuais e lançamento conjunto atômico integrados; repetição idêntica não duplica registros |
| RF-F07 | Manter receitas e despesas jurídicas | Integrado; não efetua pagamentos |
| RF-F08 | Buscar registros e mascarar documentos | Implementado; mascaramento visual não substitui autorização |
| RF-F09 | Gerir investigações, entidades e achados; consultar relações | Integração parcial; TACER/SIERA com formulário, histórico persistido e revisão humana; coletas externas exigem homologação |
| RF-F10 | Executar conectores autorizados | Parcial; depende de fonte, credenciais e filas |
| RF-F11 | Enviar e preservar evidências | Tela Arquivos integrada a envio, listagem, finalização, hash, histórico e download; depende de ingestão/cofre. Inspeção local continua separada |
| RF-F12 | Consultar/gerar relatórios | Exportações locais, listagem de rascunhos do servidor, aprovação e download de PDF; cofre precisa de homologação |
| RF-F13 | Consultar auditoria | Aba consulta eventos persistidos e verificação de cadeia da organização pela API, com tratamento de MFA/permissão |
| RF-F14 | Importar clientes/processos de JSON | Integrado a `/v1/imports/frontend-demo`; nome histórico da rota preservado |
| RF-F15 | Exibir conta, gerir equipe e salvar preferências | Conta pessoal somente leitura; equipe, convites e seleção de organização via API; preferências visuais locais |
| RF-F16 | Explorar OSINT, radar, APIs e referências | Radar CNPJ integrado ao backend com histórico; demais pesquisas do Radar e execução do catálogo ainda parciais |
| RF-F17 | Calculadoras com entradas do operador | Quatro cálculos aritméticos com parâmetros explícitos, validação e arredondamento; sem presumir calendário, índice econômico ou direito a benefício |
| RF-F18 | Plano & Consumo | Catálogo e checkout mensal Asaas Sandbox persistido; demais operações comerciais ainda sem contratação |
| RF-F19 | Transparência Pública | Consulta CEIS/CNEP/CEPIM pelo backend, com finalidade e acompanhamento da fila; token somente no servidor |
| RF-F20 | Agentes IA | Ollama desacoplado, entrada textual, fila, resultado persistido e revisão humana; depende de modelo instalado e worker |
| RF-F21 | Informações antes do login | Recursos, cadastro PF/PJ, etapas de acesso, catálogo de planos e oito perguntas frequentes; sem exigir sessão |

Identificadores das seções: `dashboard`, `clients`, `processes`, `agenda`, `deadlines`, `intimations`, `financial`, `billing`, `queries`, `osint`, `osinttools`, `agentes`, `societario`, `transparencia`, `apiexplorer`, `conhecimento`, `metadata`, `calculators`, `reports`, `audit`, `settings`.

### Catálogo comercial

Na página pública `login.html`, a navegação oferece **Recursos**, **Como começar**, **Planos** e **Dúvidas**. Os cinco planos usam o mesmo JSON da área interna. **Conhecer este plano** mostra um resumo e o atalho **Ir para cadastro** abre o formulário existente. Essa consulta não vincula um plano ao cadastro e não é gravada. Os formulários permanecem disponíveis se o catálogo falhar; o catálogo continua acessível se a API de autenticação estiver indisponível.

Abra **Plano & Consumo** no menu ou no atalho do cabeçalho. **Ver planos** compara Lite, Profissional, Escritório, Equipe e Corporate em um modal com rolagem, fechamento por Escape e navegação por teclado. O plano Profissional recebe apenas um destaque de apresentação; nenhum plano é indicado como contratado.

Os valores e limites estão em `data/commercial.json`, extraídos do `semperfi.html` fornecido na raiz. Altere esse JSON para revisar o catálogo e execute `npm run sync:backend`. O HTML de referência não é carregado nem distribuído pela aplicação.

Os seletores de adicionais, créditos e recargas foram retirados enquanto não houver contratação implementada. O catálogo preserva os planos e suas franquias para comparação. Corporate mostra condições gerais; o contato comercial ainda precisa ser configurado.

No painel, o catálogo é carregado apenas ao abrir a seção; na página pública, carrega junto à apresentação. Ambos oferecem estado de carregamento, tratamento de falha e nova tentativa. Uma falha nesse arquivo não impede o acesso aos demais módulos. Pedidos Sandbox vêm da API; não há histórico estático apresentado como operação real.

O painel **Pagamentos · Asaas Sandbox** consulta configuração, pedidos e checkout mensal por cartão em `/v1/billing`. Apenas administradores com MFA recente podem iniciar um pedido. Valores vêm do backend; repetições usam o mesmo identificador de pedido. Produção, renovação, cancelamento, adicionais e carteiras ainda exigem implementação/homologação. `/v1/financial-entries` atende ao financeiro jurídico e não é usado como checkout.

### Limites dos dados complementares

- O Perfil complementar permite registrar biografia, profissão, histórico profissional/político, cargos, bens declarados, empresas, notícias e fontes. Começa vazio; os dados são declarados pelo operador, com edição pela API e conflito de versão sinalizado. Documentos vinculam arquivos existentes da organização a clientes/processos.
- O lançamento conjunto exige revisão da descrição e das datas, grava tudo em uma transação e conclui a intimação. Datas processuais não são presumidas a partir do texto.
- A tela **Arquivos e evidências** envia originais, lista registros persistidos e permite preservar, verificar hash, consultar a custódia e baixar. A opção recolhida de inspeção temporária calcula hash/dimensões no navegador, não extrai EXIF completo nem salva vínculos; somente essas análises locais desaparecem ao recarregar.
- O roteiro consultivo foi mantido. A aba **Planos TACER / SIERA**, no dossiê da investigação, permite gerar, reabrir e revisar planejamentos persistidos. Resultados são regras fixas; não executam coleta, não debitam créditos nem comprovam fatos. A matriz ACH sem persistência continua retirada.
- Resultados da seção **Agentes IA** ficam registrados na API, incluindo falhas e limitações. O provider local e o modelo precisam ser configurados pelo administrador. “Analisar com IA” em OSINT Tools prepara o texto nesse formulário; exige revisão, finalidade, autorização e envio explícito. Registrar consultas públicas no dossiê permanece indisponível.

### Informações apresentadas ao usuário

- Estados, ações de auditoria e resultados são apresentados em português. Consultas, OSINT Tools, IA, relatórios, transparência e custódia exibem conteúdo organizado, sem JSON bruto como apresentação principal. Documentos estruturados respeitam a preferência de mascaramento, sem alterar o registro original.
- IDs de execução, modelo e referências de diagnóstico ficam recolhidos para administrador identificado pela sessão carregada. Segredos e configurações privadas nunca aparecem nesses detalhes.
- Links de pagamento e detalhes dos pedidos exigem administrador também na API. Ocultar elementos visuais não substitui autorização no servidor.
- Falhas de conexão, autorização, integridade e indisponibilidade continuam visíveis. A interface não transforma uma falha em resultado vazio ou sucesso.
- Auditoria e seu relatório para impressão consultam eventos persistidos. Atividades temporárias do navegador não são apresentadas como cadeia de auditoria.
- Recursos retirados da interface continuam pendentes no escopo de lançamento; sua retirada não conta como implementação concluída.

O fluxo de evidências do workspace OSINT envia conteúdo textual/JSON à API. A configuração padrão e `.env.example` incluem `text/plain` e `application/json`, com validação UTF-8 estrita e JSON válido no backend. Configurações antigas que sobrescrevam `ALLOWED_MIME_TYPES` precisam incluir esses tipos. Bytes originais e hash são preservados; downloads são anexos. A interface distingue arquivo recebido e preservação confirmada pelo cofre, permitindo retomar a finalização do mesmo registro. A inspeção local não substitui ingestão e preservação.

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
| RNF-F09 | Acessibilidade/contraste | Temas claro/escuro/sistema, alto contraste, fonte até 200%, espaçamento, redução de movimento, avisos persistentes, foco/teclado; auditoria manual WCAG AA completa permanece pendente |
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

### Testes de navegador

Os scripts em `tests/browser` usam Playwright/Chromium e axe-core, com versões fixadas como dependências de desenvolvimento em `package-lock.json`. Execute a partir de `front-end`:

```powershell
npm ci
npx playwright install chromium
npm run test:browser
# Aponte para um ambiente de testes Python com as dependências de back-end/uv.lock:
$env:SEMPERFI_TEST_PYTHON = "C:/caminho/do/ambiente-de-testes/Scripts/python.exe"
npm run test:browser:api
```

`functional.cjs` substitui as respostas da API e bloqueia rede externa. Verifica interações, XSS, duplicação de envio, fila, pagamentos, IA, arquivos, relatórios e acessibilidade estrutural. Renderizar as 21 abas nesse teste comprova navegação, sem atestar todos os fluxos delas.

`auth-recovery.cjs` verifica sete cenários de recuperação no navegador, com API simulada, incluindo validação, erros, reenvio, recarga, cancelamento, retorno ao login e continuidade do cadastro PJ. `client-profile.cjs` cobre edição, recarga, conflito de versão, falha de rede e modo de consulta. Os testes Python exercitam os endpoints reais com transporte de e-mail capturado. A integração contínua executa essas suítes e o navegador com API real, instalando Chromium e suas dependências no runner Linux.

`legal-live.cjs` inicia FastAPI real em porta aleatória, serve os assets sincronizados e usa SQLite novo em `back-end/var/test/browser-live-*`. Não lê a configuração privada da aplicação, não usa identidade real, não envia e-mail e não acessa Asaas/Ollama. Confere cadastro/edição, exclusões, lançamento de intimação pela tela, persistência após recarregar e eventos de auditoria. Identidade técnica de teste não homologa o login PF/PJ com SMTP real.

Na revisão de 30/09/2026 passaram **69 testes Node, 23 cenários funcionais de navegador, sete de recuperação, cinco do perfil complementar e 11 grupos de fluxos com API real**. Houve zero erros JavaScript nos cenários; as telas testadas com 320 px e texto a 200%, incluindo o Radar, não apresentaram rolagem horizontal do documento. A verificação axe dos formulários, incluindo equipe, cobre estrutura e nomes acessíveis, com contraste fora dessa execução. A revisão manual completa de acessibilidade permanece necessária.

## Prontidão para lançamento

**Critério: funcionamento comprovado de cada fluxo das 21 abas.** Uma aba só recebe aceite completo após validar entradas, gravação/leitura posterior, permissões, falhas, apresentação acessível e dependências reais no ambiente de homologação. Ações escondidas, quantidade de arquivos e número de testes não representam percentual de conclusão funcional.

### Evidências e pendências por aba — revisão de 30/09/2026

| Aba | Evidência disponível | O que ainda impede o aceite completo |
| --- | --- | --- |
| Visão Geral | Navegação e dados do bootstrap sem seed; conteúdo não confiável escapado | Conferência dos indicadores com cenários completos e carga |
| Clientes | Cadastro, perfil complementar, conflito de versão, permissões e vínculos de documentos testados | Homologação de casos profissionais, concorrência PostgreSQL e documentos no cofre real |
| Processos | Cadastro/edição, andamentos, vínculos de documentos e proteção das dependências | Monitoramento automático e homologação do cofre real |
| Agenda | Criar/editar/excluir pela tela, recarregar, estado concluído e vínculo automático de cliente | Homologação de permissões, agenda e uso concorrente no destino |
| Prazos | Criar/editar/excluir pela tela e recarga; validação de datas | Homologação operacional de conclusão, filtros e concorrência |
| Intimações | Criar e lançar pela tela; transação, idempotência, concorrência e rollback testados | Coleta automática de publicações e homologação da triagem completa |
| Financeiro | Criar/editar/excluir pela tela, valores e status persistidos; CSV seguro | Conferência completa de filtros, totais e fluxo financeiro da organização |
| Plano & Consumo | Contratos Asaas Sandbox, webhook autenticado, idempotência e papel de administrador testados | HTTPS/webhook real e ciclo comercial completo: renovação, troca, cancelamento, adicionais, créditos e franquias |
| Consultas | Envio único, acompanhamento/retomada e falhas testados | Fontes reais, credenciais/filas e registro no dossiê |
| Investigação OSINT | Vínculos, alvo protegido, políticas, TACER/SIERA com histórico e revisão persistidos | Homologação de todos os subfluxos e coleta real; concorrência PostgreSQL |
| OSINT Tools | Falha total/parcial diferenciada; preparação de análise supervisionada; preservação com retomada do recibo | Consultas ainda diretas no navegador; unificar execução/persistência no backend |
| Agentes IA | Provider, fila, estados, resposta validada, isolamento e revisão humana testados | Instalar/configurar modelo Ollama e homologar worker com entradas reais |
| Radar Societário | CNPJ pela API/fila, resultado persistido, histórico após recarga e grafo responsivo | Homologar fonte/fila reais; pesquisas por CPF/nome/endereço e importação integral do mapa para investigação |
| Transparência | Formulário e acompanhamento via backend; sem segredo no frontend | Credencial/fila e homologação CEIS/CNEP/CEPIM reais |
| API Explorer | Catálogo, busca e navegação disponíveis | Execução autenticada pelo backend e verificação das fontes do catálogo |
| ISO & Legislação | Consulta e filtro das referências | Revisão de fontes oficiais, edição e vigência; sem alegação de certificação |
| Arquivos | Upload multipart, TXT/JSON, custódia, finalização, hash, download e vínculos cliente/processo | Ferramentas de ingestão, cofre versionado e restauração reais |
| Calculadoras | 11 testes aritméticos e teste Chromium das quatro ferramentas | Homologação das entradas com casos profissionais revisados; nenhuma regra legal é presumida |
| Relatórios | Aprovação/download com permissão e falhas; PDF e hash testados; auditoria consultada na API | Cofre real, geração completa e revisão dos formatos finais |
| Auditoria | Eventos reais do núcleo, filtros, cadeia e relatório persistido testados | PostgreSQL/RLS, concorrência e retenção no ambiente de destino |
| Configurações | Equipe, convites manuais, perfis, suspensão, revogação de sessões e troca de organização; preferências e acessibilidade | Homologação multiusuário com identidade/Redis/PostgreSQL reais e tecnologias assistivas |

**Aceite integral para lançamento: 0/21 abas homologadas no destino (0%).** Esse indicador mede homologação completa segundo o critério acima. As evidências de implementação e funcionamento local estão discriminadas na tabela. Não há base para estimar um percentual único de desenvolvimento pelas linhas de código ou pelas telas existentes.

Persistem pendências internas de implementação e externas de infraestrutura. Não existe hospedagem HTTPS configurada; Asaas permanece Sandbox desabilitado até configurar retorno/webhook. Ollama permanece sem modelo escolhido. Antes do lançamento, também falta homologar PostgreSQL/RLS, Redis/workers, cofre, restauração de backup, segurança e acessibilidade manual. Todas as 21 abas permanecem no escopo solicitado.

**Data de entrega informada: 17/10/2026.** O aceite depende dos fluxos e serviços acima; essa data não transforma funcionalidades parciais em entregas concluídas. A prioridade seguinte é execução das OSINT Tools no backend, ciclo comercial e homologação das dependências reais.

### Correções de continuidade — 29/09/2026

Os problemas identificados na revisão de 27/09 receberam as correções abaixo. A matriz acima continua sendo a referência para funcionalidades e dependências ainda pendentes.

| Prioridade | Fluxo | Alteração |
| --- | --- | --- |
| 1 | Busca global | Título e resultados escapados; documentos mantêm apenas dois dígitos finais com máscara ativa, inclusive CPF/CNPJ formatado; resultados são botões acessíveis por teclado. |
| 1 | Vínculos jurídicos | Exclusões com dependências e trocas de cliente incompatíveis retornam 409 com orientação. Histórico não é apagado por cascata. |
| 2 | OSINT e preservação | Falha DNS total interrompe o fluxo, falha parcial é sinalizada; GitLab vazio não confirma perfil. Preservação depende da confirmação do cofre; recibos são reutilizados, inclusive evidência já vinculada ao achado após recarga. Conclusão assíncrona não troca a aba atual. |
| 2 | Organização nas tarefas | Tenant validado no envio e antes do acesso aos dados; filtros explícitos e contexto transacional RLS. Repetições concluídas não executam o provedor novamente. PostgreSQL e broker reais continuam pendentes de homologação. |
| 3 | Apresentação | “Fechar” encerra o painel de notificações; exportação informa “dados carregados”; Radar ativo apresenta resultado e histórico, sem botão de JSON bruto. Cadastro de investigação é apresentado como preparação para revisão. |

**Revalidação nesta data:** 61 arquivos passaram pela verificação de sintaxe JavaScript/JSON, UTF-8 e charset HTML; 44 arquivos de distribuição estão sincronizados. Os testes funcionais e de recuperação no navegador usam API simulada; `legal-live.cjs` usa API real e banco isolado. Os 415 testes Python aprovados estão detalhados no README do backend. Essas evidências não constituem homologação das 21 abas com serviços reais.

### Entregas funcionais — 30/09/2026

| Onde acessar | Operações implementadas | Proteções e limites |
| --- | --- | --- |
| Clientes → Abrir → Perfil complementar | Consultar e editar dados pessoais complementares, sete grupos de históricos/fontes, adicionar/remover registros e salvar | Versão impede sobrescrever edição de outra pessoa; falhas mantêm o formulário; confirmação antes de sair com alterações; fontes HTTP(S), máscara de CNPJ e conteúdo escapado |
| Cliente → Documentos / Processo → Arquivos | Listar, vincular arquivo existente, reabrir, baixar quando preservado e remover vínculo | Organização e registro ativo conferidos pela API; somente leitura para auditor; exclusão do cliente/processo bloqueada enquanto houver vínculos; arquivo original mantido |
| Configurações → Organização e equipe | Gerar/revogar convite manual, conferir/aceitar convite, selecionar organização, alterar perfil, suspender/reativar integrante | Administrador e MFA recente nas alterações; último administrador protegido; vínculo suspenso não afeta outras organizações; sessões antigas continuam revogadas após reativação |
| Investigação → Planos TACER / SIERA | Gerar plano, consultar histórico/detalhe e registrar revisão humana | Escopo aprovado, autorização e organização conferidos; reenvio com a mesma solicitação não duplica; revisão registrada uma única vez; nenhum serviço externo executado por esse formulário |

O convite é compartilhado manualmente pelo administrador: não há alegação de envio automático de e-mail. O destinatário precisa autenticar a conta do e-mail convidado, confirmar o código de segurança e reabrir o convite. Tokens não são armazenados em localStorage.

**Validação:** 67 arquivos verificados em UTF-8/sintaxe/charset, 48 arquivos sincronizados para a API, 472 testes Python aprovados. O navegador com API real foi ampliado para perfil, vínculo/remoção de documento e plano/revisão após recarga. Nesse teste, apenas os metadados do arquivo original são preparados como fixture no banco descartável; upload e cofre reais continuam pendentes. Migrações até `20260929_0008` testadas em SQLite isolado. Para disponibilizar as novas rotas, o backend precisa carregar a nova versão; em produção, aplicar as migrations antes de iniciar.

**Infraestrutura:** continuam pendentes a homologação HTTPS/webhook do Asaas Sandbox, o modelo/serviço Ollama e o funcionamento completo de filas, PostgreSQL/RLS e cofre. Portas abertas e health checks não comprovam esses fluxos.

**Ordem de continuidade:** completar persistência e integração dos fluxos da matriz; configurar e homologar serviços reais; executar o aceite de cada aba, incluindo permissões, acessibilidade, falhas e restauração. Os testes de navegador estão declarados em `package.json`, com versões fixadas de Playwright/axe-core e execução incluída na integração contínua.
