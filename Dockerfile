# ---- build stage ----
# node:22-bookworm ships with python3/make/g++ (via buildpack-deps), avoiding
# the slow apt-get install. bun is installed via npm.
# better-sqlite3 native addon needs these to compile; vite build also evaluates
# db/index.ts (top-level `new Database()`), so the binding must be present here.
FROM node:22-bookworm AS build
RUN npm install -g bun
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN bun install
COPY apps apps
COPY packages packages
RUN bun --filter remote-reader-web build
# Strip devDependencies (vite / svelte-check / drizzle-kit / typescript / ...).
# bun install is incremental: on an existing node_modules it adds missing prod
# deps but won't remove already-installed devDeps. So wipe node_modules first,
# then do a fresh prod-only install. Native addons (better-sqlite3, @node-rs/argon2)
# recompile here (toolchain still present) and are copied to the slim runtime.
# bun.lock is dropped because the prod dep set differs from the full lockfile and
# trips the frozen guard; re-resolving from package.json semver keeps prod
# versions. This rm is layer-local and never touches the host's bun.lock.
RUN rm -rf node_modules apps/web/node_modules packages/shared/node_modules bun.lock \
    && bun install --production

# ---- runtime stage ----
# node:22-slim has no build toolchain; precompiled .node files come from build.
# The workspace:* dep is inlined by vite into apps/web/build, so not reinstalled.
FROM node:22-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web/build ./apps/web/build
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# 查 /api/health（含 DB SELECT 1），DB/磁盘故障时 503 → healthcheck 失败（M15）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
# Container starts as root so the entrypoint can chown the bind-mounted data dir
# (host may create it root-owned), then drops to the node user to run the server.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/web/build/index.js"]
