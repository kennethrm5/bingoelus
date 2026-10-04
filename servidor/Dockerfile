FROM node:20-alpine

ENV NODE_ENV=development \
    PORT=3000

WORKDIR /app

COPY servidor/package.json servidor/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY servidor/server.js servidor/casillas.json ./
COPY servidor/public/ ./public/
COPY media/ ./media/

RUN mkdir -p /app/resultados && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "server.js"]
