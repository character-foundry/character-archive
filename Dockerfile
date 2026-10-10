FROM node:22-alpine AS backend-deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate && \
    apk add --no-cache python3 py3-setuptools make g++
COPY package.json pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile --prod && \
    cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && \
    npm run build-release

FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ENV NODE_ENV=production
ENV INTERNAL_API_URL=http://api:6969
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache sqlite wget tini
COPY --from=backend-deps /app/node_modules ./node_modules
COPY --from=backend-deps /app/package.json ./package.json
RUN node -e "import('@character-foundry/character-foundry/loader')"
COPY server.js config-loader.js ./
COPY backend ./backend
COPY scripts ./scripts
COPY --from=frontend-build /app/frontend/.next/standalone ./frontend
COPY --from=frontend-build /app/frontend/.next/static ./frontend/.next/static
COPY frontend/public ./frontend/public
RUN chmod a+r package.json server.js config-loader.js && \
    chmod -R a+rX backend scripts frontend && \
    mkdir -p /state /app/static /app/data /app/backup

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=6969 \
    CHARACTER_ARCHIVE_STATE_DIR=/state \
    CHARACTER_ARCHIVE_DB_FILE=/state/cards.db \
    CHARACTER_ARCHIVE_CONFIG_FILE=/state/config.json \
    CHARACTER_ARCHIVE_STATIC_DIR=/app/static \
    CHARACTER_ARCHIVE_DATA_DIR=/app/data \
    CHARACTER_ARCHIVE_BACKUP_DIR=/app/backup \
    SQLITE_MMAP_SIZE=536870912 \
    SQLITE_BUSY_TIMEOUT_MS=15000

EXPOSE 6969 3177
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
