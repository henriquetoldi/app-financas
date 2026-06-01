# syntax=docker/dockerfile:1.7

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# Avoid BuildKit cache mounts on Railway because custom cache mount IDs can be
# rejected by the builder and mounted node_modules caches can conflict with npm ci.
RUN npm ci --include=dev

COPY . .

RUN npm run build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
