FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates curl && rm -rf /var/lib/apt/lists/*
# Amazon RDS certificate bundle, so the app can verify the database's TLS certificate (use DATABASE_SSL_CA_FILE=/app/certs/rds-global-bundle.pem).
RUN mkdir -p /app/certs && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /app/certs/rds-global-bundle.pem && test -s /app/certs/rds-global-bundle.pem
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
