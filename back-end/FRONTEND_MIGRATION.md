# Integração da interface com /v1

O frontend editável está em `../front-end`; `app/static/frontend` é gerado por `npm run sync:backend`. A entrada verifica a sessão, carrega o bootstrap e só então mostra o painel. `localStorage` contém preferências visuais, não a base operacional.

## Fluxos existentes

- CRUD de clientes/processos e recursos jurídicos em `assets/js/app.js`.
- Investigações, entidades, achados, conectores e evidências conectados aos endpoints existentes.
- Importação explícita de clientes/processos via `/v1/imports/frontend-demo`; o nome histórico foi mantido por compatibilidade.
- Sessão HttpOnly e saída de conta; credenciais institucionais permanecem no provedor.

## Pendências identificadas

| Área | Trabalho necessário |
| --- | --- |
| Perfil 360° | Persistir todos os documentos, vínculos e campos adicionais hoje mantidos somente no estado da UI |
| Lançamento conjunto de intimação | Criar operação transacional para andamento, prazo, compromisso e alteração de status |
| Exportação/relatórios | Unificar exportações do navegador com controle e auditoria da API |
| Ferramentas OSINT e catálogo de APIs | Encaminhar os recursos que ainda consultam serviços diretamente pelo backend autorizado |
| Transparência | Integrar a tela de catálogo; ela não executa consultas nem solicita segredos |
| Assinaturas/créditos | Implementar persistência comercial antes de reintroduzir ações; simulações removidas |
| IA supervisionada | Configurar provedor, persistir conclusão de jobs e homologar revisão humana |
| Segurança/performance | Revisar interpolações HTML, eliminar handlers inline e paginar listas grandes |

Não invente respostas para suprir integração indisponível. Informe a falha ou indisponibilidade e preserve os registros existentes.
