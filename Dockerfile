FROM node:20-slim

RUN mkdir -p /data /home/node/app \
    && chown -R node:node /data /home/node

USER node
WORKDIR /home/node/app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

ENV NODE_ENV=production \
    PORT=7860 \
    CONFIG_DATA_DIR=/data
EXPOSE 7860

CMD ["node", "addon.js"]
