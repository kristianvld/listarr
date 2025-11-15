FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Create data directory for persistent storage
RUN mkdir -p /app/data

# Set default data directory for Docker (can be overridden via env)
ENV DATA_DIR=/app/data

# Expose port (default 3000, configurable via env)
EXPOSE 3000

# Run the application
CMD ["bun", "run", "src/index.ts"]

