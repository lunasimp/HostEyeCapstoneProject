FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY feature-builder.js ./
COPY feature-indexer.js ./
COPY raw-log-indexer.js ./
CMD ["node", "feature-builder.js"]
