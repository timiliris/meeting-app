FROM node:20-alpine

WORKDIR /app

# Installation des dépendances
COPY package.json ./
RUN npm install --omit=dev

# Code applicatif
COPY server.js ./
COPY public ./public

# Dossier pour la persistance JSON (monté en volume)
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "server.js"]
