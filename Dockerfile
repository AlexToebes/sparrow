
# R66: multi-stage, non-root, listens on PORT, data in the /data volume.

# ---- build: all workspaces, compile shared + server, bundle the web UI -------------------------
FROM node:24.21.0-slim AS build
WORKDIR /repo

# Install the pnpm version pinned in package.json ("packageManager"), so there is one source of truth.
COPY package.json ./
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"

# Dependency layer: manifests only, so source edits do not invalidate the install.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
RUN pnpm build
# No source maps in the image (the vite build emits none unless SOURCEMAP=1; this keeps it that way).
RUN find packages/web/dist -name '*.map' -delete

# Production-only server tree: dist, drizzle migrations and prod node_modules,
# with @sparrow/shared injected as a copy of its built dist.
RUN pnpm --filter @sparrow/server deploy --prod /out

# ---- runtime: production dependencies only ------------------------------------------------------
FROM node:24.21.0-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/web
WORKDIR /app

COPY --from=build /out/ ./
COPY --from=build /repo/packages/web/dist ./web

# /data is created and owned before VOLUME, so a fresh volume is writable by the non-root user.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

# R67: liveness only (no curl in the slim image, so use node).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/main.js"]
