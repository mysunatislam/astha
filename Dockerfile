# Astha: one Node process serves the API and the built PWA from the same origin.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY server ./server
COPY web ./web

ENV NODE_ENV=production
# Production storage must be supplied explicitly. Local SQLite remains available
# with DB_PROVIDER=sqlite and a persisted /data volume.
ENV DB_PROVIDER=supabase
ENV DB_PATH=/data/astha.db
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "server/check-health.mjs"]

CMD ["node", "server/index.js"]
