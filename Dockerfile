# One image, three commands (ADR-021): the API (default), the worker and the migration job.
#   API      tsx src/server.ts            Cloud Run service treecord-api
#   worker   tsx src/worker.ts            Cloud Run service treecord-worker, exactly one instance (NFR-076)
#   migrate  tsx scripts/migrate.ts       Cloud Run job treecord-migrate, run before every deploy
# Configuration comes from the environment and Secret Manager, never from a file in the image (ADR-014).
FROM node:24-alpine
WORKDIR /app
# the pnpm version the repository is developed with, so the lockfile resolves the same way it does locally
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: the husky git hooks have nothing to do in an image
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
ENV NODE_ENV=production
USER node
CMD ["node_modules/.bin/tsx", "src/server.ts"]
