# Slaver — single-container self-hosted build (no Cloudflare).
# Stage 1: frontend (npm workspaces: tailwind lives in the root package.json)
FROM node:22-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json* ./
COPY frontend/package.json ./frontend/
RUN npm install --no-audit --no-fund
COPY frontend/ ./frontend/
RUN npm --workspace frontend run build

# Stage 2: backend
FROM rust:1.91-slim AS backend
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config ca-certificates && rm -rf /var/lib/apt/lists
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --release

# Stage 3: runtime (trixie matches the rust:1.91 toolchain's glibc)
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client && rm -rf /var/lib/apt/lists
WORKDIR /app
COPY --from=backend /app/target/release/slaver ./slaver
COPY --from=frontend /app/frontend/dist ./frontend/dist
COPY migrations ./migrations
COPY seeds ./seeds
ENV PORT=8080 \
    DB_PATH=/data/slaver.db \
    AVATAR_DIR=/data/avatars \
    WORK_DIR=/data/workspaces \
    MIGRATIONS_DIR=./migrations \
    SEEDS_DIR=./seeds \
    FRONTEND_DIR=./frontend/dist
EXPOSE 8080
VOLUME ["/data"]
CMD ["./slaver"]
