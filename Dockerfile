FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3002
EXPOSE 3002
CMD ["node", "--experimental-sqlite", "server.js"]
