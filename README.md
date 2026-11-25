# MapCidade Change Monitoring BI

Anonymized, from-scratch reconstruction of a real internal tool's architecture, built for a portfolio. Fictional data only ("MapCidade") — no real company, city, or infrastructure is represented here.

## English

**Problem.** A consolidated alert feed showed the latest status, while edit logs and contract milestones lived in separate systems. Teams needed to see how review activity and deadlines related to the outstanding alerts.

**Solution.** An ETL reads a consolidated feed and municipal edit logs into SQLite. It keeps the last complete data when a source fails, deduplicates alerts, and stores daily snapshots and status changes. A metadata-driven register recalculates business-day deadlines and records edits with optimistic locking.

**Stack.** TypeScript, Express, SQLite, Vitest.

**How to run.** With Node.js 22.13 or later:

```sh
npm ci
npm run seed
npm run build
npm start
```

**Demo.** Open http://localhost:4401 and sign in with `demo / demo-password`. Select a municipality and switch between alert counts, edit activity, snapshots, and ETL status. Try `npm run demo:advance -- 2026-11-02` to add a snapshot with a simulated consolidation failure. The API also exposes the contract, schedule, visit and report registers under `/api/register`, including edits and CSV export.

**What I learned.** A status update in the consolidated feed measures load activity, so the BI reads municipal edits separately to measure review activity. The demo replaces external consolidation, PostgreSQL and corporate sign-in with a fixture generator, SQLite and a local user directory. The web demo presents a selection of API views.

## Português

**Problema.** A carga consolidada mostrava a situação mais recente dos alertas. Os registros de edição e os prazos contratuais ficavam em sistemas separados. A equipe precisava relacionar o trabalho de análise e os prazos ao estoque de alertas.

**Solução.** Um ETL reúne alertas e logs municipais em SQLite, deduplica registros e mantém a última carga completa quando a fonte falha. O histórico guarda mudanças de status e snapshots diários. O cadastro calcula prazos em dias úteis e registra alterações com controle de versão.

**Stack.** TypeScript, Express, SQLite, Vitest.

**Como rodar.** Use Node.js 22.13 ou superior. Execute `npm ci`, `npm run seed`, `npm run build` e `npm start`.

**Demo.** Abra http://localhost:4401 e entre com `demo / demo-password`. Filtre por município e explore alertas, atividade de edição, snapshots e cargas. Rode `npm run demo:advance -- 2026-11-02` para gerar um segundo snapshot com uma falha simulada. A API de cadastro oferece edição e exportação em CSV.

**O que aprendi.** A data de atualização na carga mede a atividade do carregador. Para medir a análise municipal, usei os logs de edição. A demo usa um gerador sintético, SQLite e um diretório local de usuários para reproduzir o fluxo sem infraestrutura externa.
