# Astha: one Node process serves the API and the built PWA from the same origin.
FROM node:22-slim
WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY web ./web

ENV NODE_ENV=production
ENV DB_PATH=/data/astha.db
VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "server/index.js"]
