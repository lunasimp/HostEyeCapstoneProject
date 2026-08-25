FROM node:20-alpine

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production PORT=5174
EXPOSE 5174
CMD ["node", "server.js"]
