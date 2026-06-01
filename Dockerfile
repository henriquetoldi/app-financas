# syntax=docker/dockerfile:1.7

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --include=dev

COPY . .

RUN npm run build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
