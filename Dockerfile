# docker build --build-context foundry=../character-foundry -t character-archive .

FROM node:22-alpine AS packages
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
COPY --from=foundry package.json pnpm-lock.yaml ./
COPY --from=foundry packages/core ./packages/core
COPY --from=foundry packages/schemas ./packages/schemas
COPY --from=foundry packages/image-utils ./packages/image-utils
COPY --from=foundry packages/charx ./packages/charx
COPY --from=foundry tsconfig.base.json ./tsconfig.base.json
COPY docker/pnpm-foundry-workspace.yaml ./pnpm-workspace.yaml
RUN node -e "const fs=require('fs');const p=require('./package.json');delete p.packageManager;fs.writeFileSync('package.json',JSON.stringify(p,null,2))" && \
    pnpm install --frozen-lockfile

WORKDIR /build/packages/core
RUN pnpm run build
WORKDIR /build/packages/schemas
RUN pnpm run build
WORKDIR /build/packages/image-utils
RUN pnpm run build
WORKDIR /build/packages/charx
RUN pnpm run build

FROM node:22-alpine AS backend-deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate && \
    apk add --no-cache python3 py3-setuptools make g++
COPY --from=packages /build/packages /packages
COPY package.json pnpm-lock.yaml ./
COPY docker/pnpm-backend-workspace.yaml ./pnpm-workspace.yaml
RUN sed -i 's|"@character-foundry/image-utils": "workspace:\^"|"@character-foundry/image-utils": "file:/packages/image-utils"|' package.json && \
    sed -i 's|"@character-foundry/schemas": "workspace:\^"|"@character-foundry/schemas": "file:/packages/schemas"|' package.json && \
    node -e "const fs=require('fs');const p=require('./package.json');p.dependencies['@character-foundry/charx']='file:/packages/charx';fs.writeFileSync('package.json',JSON.stringify(p,null,2))" && \
    sed -i 's|"workspace:\^"|"file:/packages/core"|' /packages/charx/package.json && \
    sed -i 's|"@character-foundry/schemas": "file:/packages/core"|"@character-foundry/schemas": "file:/packages/schemas"|' /packages/charx/package.json
RUN pnpm install --no-frozen-lockfile --prod && \
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
COPY --from=packages /build/packages /packages
COPY --from=backend-deps /app/node_modules ./node_modules
COPY --from=backend-deps /app/package.json ./package.json
RUN mkdir -p node_modules/@character-foundry && \
    ln -sfn /packages/image-utils node_modules/@character-foundry/image-utils && \
    node -e "Promise.all(['@character-foundry/charx', '@character-foundry/image-utils', '@character-foundry/schemas'].map((name) => import(name)))"
COPY server.js config-loader.js ./
COPY backend ./backend
COPY scripts ./scripts
COPY --from=frontend-build /app/frontend/.next/standalone ./frontend
COPY --from=frontend-build /app/frontend/.next/static ./frontend/.next/static
COPY frontend/public ./frontend/public
RUN mkdir -p /state /app/static /app/data /app/backup

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
