FROM node:18-alpine

WORKDIR /app

# Install production dependencies only.
COPY app/package*.json ./
RUN npm ci --omit=dev

# Copy application source and configuration.
COPY app/src/ ./src/
COPY config/  ./config/

ENV NODE_ENV=production \
    CONFIG_PATH=/app/config/policies.yaml

EXPOSE 3000

CMD ["node", "src/server.js"]
