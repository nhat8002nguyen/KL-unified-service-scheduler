FROM node:24-alpine

WORKDIR /app

# Install ALL dependencies (dev included) — the build needs typescript, and the
# container entrypoint runs `db:setup` via tsx. Setting NODE_ENV=production
# before `npm ci` would omit those and break both.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production

EXPOSE 8080

# migrate + seed (seed is a no-op when data already exists), then serve
CMD ["sh", "-c", "npm run db:setup && node dist/server.js"]
