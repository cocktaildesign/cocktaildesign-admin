FROM node:20.20.0-alpine
WORKDIR /app
COPY worker.mjs /app/worker.mjs
COPY orders.mjs /app/orders.mjs
USER node
CMD ["node", "/app/worker.mjs"]
