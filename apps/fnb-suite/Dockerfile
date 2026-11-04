# One container per client deployment: MCP API + admin SPA + Astro store, SQLite on a volume.
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY store/package.json store/bun.lock ./store/
RUN cd store && bun install --frozen-lockfile
COPY . .
RUN bun run build

# Runtime: production dependencies only (no Vite, TypeScript, or test tooling).
FROM oven/bun:1.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/fnb.db \
    ADMIN_DIR=/app/admin/dist \
    STORE_ENTRY=/app/store/dist/server/entry.mjs
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY store/package.json store/bun.lock ./store/
RUN cd store && bun install --production --frozen-lockfile
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/admin/dist ./admin/dist
COPY --from=build /app/store/dist ./store/dist
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]
EXPOSE 8080
USER bun
CMD ["bun", "src/server.ts"]
