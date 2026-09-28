FROM node:20.20.0-alpine
WORKDIR /app
COPY worker.mjs /app/worker.mjs
USER node
CMD ["node", "/app/worker.mjs"]
