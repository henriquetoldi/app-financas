FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# Keep this install step intentionally free of BuildKit cache mounts: Railway
# validates cache mount IDs and npm ci must be able to recreate node_modules.
RUN npm ci --include=dev

COPY . .

RUN npm run build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
