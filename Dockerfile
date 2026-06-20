FROM node:20-slim

RUN useradd -m -u 1000 user \
    && mkdir -p /data /home/user/app \
    && chown -R user:user /data /home/user

USER user
WORKDIR /home/user/app

COPY --chown=user:user package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=user:user . .

ENV NODE_ENV=production \
    PORT=7860 \
    CONFIG_DATA_DIR=/data
EXPOSE 7860

CMD ["node", "addon.js"]
