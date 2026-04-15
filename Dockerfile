# ══════════════════════════════════════════════════════════════
# Dockerfile — Viralio Scheduler
# Optimizat pentru Coolify pe Hetzner
# ══════════════════════════════════════════════════════════════

FROM node:20-alpine

# Install form-data (used for Facebook multipart upload)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Instalăm dependențele mai întâi (cache layer)
COPY package*.json ./
RUN npm ci --only=production

# Copiem codul
COPY . .

# Director pentru upload-uri (montat ca volum în producție)
RUN mkdir -p uploads

# User non-root pentru securitate
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodeapp -u 1001 && \
    chown -R nodeapp:nodejs /app
USER nodeapp

EXPOSE 3005

# dumb-init gestionează semnalele corect (importante pentru Bull)
CMD ["dumb-init", "node", "server.js"]
