FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY scripts ./scripts
COPY src/data.js ./src/data.js
COPY --from=build /app/dist ./dist
RUN mkdir -p /data/uploads /data/backups && chown -R node:node /data /app
USER node
ENV UPLOAD_DIR=/data/uploads BACKUP_DIR=/data/backups
EXPOSE 3001
CMD ["node", "server/index.js"]
