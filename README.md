# treecord-backend

Backend for treecord

## Processes

| Command                | What runs                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docker compose up -d` | PostgreSQL, MinIO and anvil with the contracts from the root's `contracts/` submodule deployed                                                   |
| `npm run db:migrate`   | The schema                                                                                                                                       |
| `npm start`            | The API (`src/server.ts`)                                                                                                                        |
| `npm run worker`       | The worker (`src/worker.ts`): indexer, relayer lanes, scheduler, scoring with the mock AI ([ADR-021](../docs/architecture-decisions.md#adr-021)) |

`WORKER_MODE` is `all` (default), `indexer` or `relayer`. Run exactly one `all` or `relayer` process per operator and
relayer wallet (NFR-076): each keeps its own transaction nonces. The worker reads the same `.env` as the API; see
`.env.example`. Health and metrics: `GET :8080/health`, `GET :8080/metrics` (`WORKER_PORT`).

> Branch `feat/cre-keeper`: the Chainlink CRE keeper demo. What is left before it can merge is in
> treecord-contracts `README.md` → "What's left".
