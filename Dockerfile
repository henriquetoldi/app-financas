# syntax=docker/dockerfile:1.7

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# Cache only npm's global cache. Do not mount /app/node_modules/.cache because
# npm ci removes/recreates node_modules and Railway/BuildKit can fail with EBUSY
# when that directory is a mounted cache.
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm ci --include=dev --cache /root/.npm

COPY . .

RUN npm run build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
