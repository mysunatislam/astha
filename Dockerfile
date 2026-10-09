# Astha: one Node process serves the API and the built PWA from the same origin.
FROM node:24.21.0-bookworm-slim
WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY server ./server
COPY web ./web

ENV NODE_ENV=production
ENV DB_PATH=/data/astha.db
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node

CMD ["node", "server/index.js"]
