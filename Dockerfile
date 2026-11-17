FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS base
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
