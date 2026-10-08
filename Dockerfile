# Stage 1: Build the NestJS application
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests and Prisma schema first (for caching)
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies)
RUN npm ci

# Generate the Prisma client
RUN npx prisma generate

# Copy the rest of the source code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# ==========================================
# Stage 2: Production environment
FROM node:20-alpine

WORKDIR /app

# Set Node to production mode
ENV NODE_ENV=production

# Copy package manifests and Prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install ONLY production dependencies (skips devDependencies to keep image small)
RUN npm ci --omit=dev

# Copy the compiled application and generated Prisma client from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Expose the application port
EXPOSE 3000

# Start the NestJS application
CMD ["npm", "run", "start:prod"]
