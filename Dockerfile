FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates openssl unzip python3 make g++ \
    && curl -L -o /tmp/xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip \
    && unzip -o /tmp/xray.zip -d /usr/local/bin xray \
    && chmod +x /usr/local/bin/xray \
    && rm -f /tmp/xray.zip \
    && apt-get purge -y unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY service/package.json ./package.json
RUN npm install --omit=dev

COPY service/src ./src
COPY service/public ./public
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8444
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
