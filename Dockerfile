# Multi-stage build. Build stage installs native-module toolchain
# (python3/make/g++) so better-sqlite3 compiles cleanly. Runtime stage is
# slim Node with only dist/ + public/ + production deps.
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Toolchain for compiling better-sqlite3 native binding
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build

# Runtime stage — smaller image, no toolchain
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# Same toolchain present at runtime in case `npm install --omit=dev`
# needs to rebuild native bindings on this platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 3000
CMD ["node", "dist/index.js"]
