FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production PORT=5055
EXPOSE 5055
CMD ["node", "src/server.js"]
