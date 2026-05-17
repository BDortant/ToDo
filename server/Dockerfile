FROM node:20-alpine

# better-sqlite3 has a native module — build deps are tiny on alpine.
RUN apk add --no-cache python3 make g++ \
    && mkdir -p /app /app/data /app/public

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js db.js ./

ENV NODE_ENV=production \
    PORT=8084 \
    DATA_DIR=/app/data \
    PUBLIC_DIR=/app/public

EXPOSE 8084

CMD ["node", "server.js"]
