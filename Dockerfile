FROM oven/bun:1.4.5-alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b AS base
USER root
RUN apk upgrade --no-cache
WORKDIR /app

FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun run build:css

FROM base AS runtime
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --from=build /app/src ./src
COPY tsconfig.json ./
RUN chmod -R a+rX /app/src /app/tsconfig.json && mkdir -p /app/data && chown bun:bun /app/data
ENV DATA_DIR=/app/data
EXPOSE 3000
USER bun
CMD ["bun", "run", "src/index.ts"]
