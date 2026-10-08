FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 8080

# migrate + seed, then serve
CMD ["sh", "-c", "npm run db:setup && node dist/server.js"]
