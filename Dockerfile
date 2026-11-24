FROM node:24.22.1-alpine AS build
WORKDIR /app
# better-sqlite3 has a native binding; alpine (musl) usually needs to build
# it from source rather than use a prebuilt glibc binary.
RUN apk add --no-cache python3 make g++
# cli-provenance.json: the CLI helpers' git history, added to the deploy archive by scripts/deploy-archive.sh because this
# stage has no .git (scripts/cli-build-info.mjs, provenance "deploy-archive"). The trailing * keeps a build from a plain
# checkout, which has no such file, working: a wildcard that matches nothing is skipped when another source matches.
COPY package*.json cli-provenance.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# npm run build also packs cli/ (with the fleet helpers from scripts/, examples/hooks/ and examples/opencode-plugin/)
# into dist/cli/opencadre-cli.tgz, which the hub serves to the console connect command.
COPY cli ./cli
COPY scripts ./scripts
COPY examples/hooks ./examples/hooks
COPY examples/opencode-plugin ./examples/opencode-plugin
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.22.1-alpine
WORKDIR /app
ENV NODE_ENV=production
# Reuse the build stage's already-compiled node_modules (including the
# native better-sqlite3 binding) instead of re-running npm ci here, which
# would need the same python3/make/g++ toolchain a second time.
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist
COPY public ./public
# Archives may have been unpacked under a restrictive umask. Public assets and code must be
# readable by the runtime user while remaining owned by root and unwritable by that user.
RUN find /app -type d -exec chmod 755 {} + && find /app -type f -exec chmod u=rwX,go=rX {} +
RUN mkdir -p /app/data && chown 1000:1000 /app/data && chmod 750 /app/data
USER 1000:1000
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]
