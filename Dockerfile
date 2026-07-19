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

# ---- runtime stage ----
# Pre-compiled native addons (.node files) are copied from the build stage, so
# node:22-slim needs no build toolchain. The workspace:* dep is inlined by vite
# into apps/web/build, so we don't reinstall via npm.
FROM node:22-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web/build ./apps/web/build
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/web/build/index.js"]
