FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

CMD ["node", "src/app.js"]
