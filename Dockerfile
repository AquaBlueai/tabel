FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DB_PATH=/app/data/tabel.db
VOLUME /app/data
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
