FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/index.js"]