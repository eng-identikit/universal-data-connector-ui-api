FROM node:22-bookworm-slim

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

ENV NODE_ENV=production
EXPOSE 9000
USER node
CMD ["node", "index.js"]
