# ---- Stage 1: Install dependencies (compiles native modules like argon2) ----
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci

# ---- Stage 2: Build the Next.js app ----
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# prisma generate reads schema.prisma only — no live DB connection needed
RUN npx prisma generate
RUN npx next build

# ---- Stage 3: Production runtime (minimal image) ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Next.js standalone output (bundles server + minimal node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static
COPY --from=builder /app/public ./public

# Prisma generated client + query engine binary (not auto-traced by standalone output)
COPY --from=builder /app/node_modules/.prisma          ./node_modules/.prisma
# Prisma CLI packages needed for `prisma migrate deploy` on startup
COPY --from=builder /app/node_modules/prisma           ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma          ./node_modules/@prisma
COPY --from=builder /app/prisma                        ./prisma

# argon2 native binary — standalone output does not include native .node files
COPY --from=builder /app/node_modules/argon2           ./node_modules/argon2

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Run Prisma schema migrations then start the Next.js standalone server
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node server.js"]
