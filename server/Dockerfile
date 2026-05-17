FROM node:20-alpine

# better-sqlite3 has a native module — build deps are tiny on alpine.
RUN apk add --no-cache python3 make g++ \
    && mkdir -p /app /app/data /app/public

WORKDIR /app

# Build context is the repo root (see compose.yml) so all paths
# below are repo-relative.

COPY server/package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server/server.js server/db.js ./

# Frontend files baked in. Edit the repo's index.html / app.js /
# style.css then rebuild with `docker compose up -d --build`.
COPY index.html app.js style.css /app/public/

# Hand everything to the bundled non-root `node` user (uid 1000)
# so a process escape doesn't get root over the data volume.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=8084 \
    DATA_DIR=/app/data \
    PUBLIC_DIR=/app/public

EXPOSE 8084

CMD ["node", "server.js"]
