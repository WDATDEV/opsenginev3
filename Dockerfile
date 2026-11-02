FROM node:22-bookworm-slim

RUN npm install -g pnpm@12.3.4

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production

# APP_ROLE=worker runs the sweep. Anything else migrates, optionally seeds, then starts the API.
CMD ["sh", "-c", "if [ \"$APP_ROLE\" = \"worker\" ]; then exec pnpm --filter @opsengine/worker start; fi; pnpm db:push && if [ \"$SEED_ON_BOOT\" = \"1\" ]; then pnpm db:seed; fi && exec pnpm --filter @opsengine/api start"]
