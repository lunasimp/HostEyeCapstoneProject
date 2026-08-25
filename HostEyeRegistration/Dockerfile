FROM node:20-alpine

RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production PORT=5054
EXPOSE 5054
CMD ["node", "src/server.js"]
