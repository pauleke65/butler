# Butler MCP server for AgentCore Runtime (linux/arm64). Build from the repo root:
#   docker buildx build --platform linux/arm64 -f server/Dockerfile -t butler-server .
# Not built or run in CI yet (ticket M-23).
FROM --platform=linux/arm64 node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/contracts/ts packages/contracts/ts
COPY server server
RUN pnpm install --frozen-lockfile --filter @butler/server... --filter @butler/ui... \
 && pnpm --filter ./server/ui build

FROM --platform=linux/arm64 node:22-slim
ENV NODE_ENV=production PORT=8000 STAGE=demo
WORKDIR /repo
COPY --from=build /repo /repo
EXPOSE 8000
CMD ["node_modules/.bin/tsx", "server/src/index.ts"]
