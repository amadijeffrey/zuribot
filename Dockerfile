FROM node:20-alpine AS builder

WORKDIR /app

# Prisma needs OpenSSL to generate/run its query engine on Alpine.
RUN apk add --no-cache openssl

# Copy the Prisma schema before install so the `postinstall` hook
# (prisma generate) can find it during `npm ci`.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .

RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

# Same OpenSSL requirement at runtime.
RUN apk add --no-cache openssl

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./

RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "dist/server.js"]
