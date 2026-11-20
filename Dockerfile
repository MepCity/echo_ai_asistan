FROM node:22-alpine
WORKDIR /app
# ImageMagick for the studio's add_logo (composites the club logo PNG); the echo service shares this image.
# PNG is in the main package; jpeg/webp coders for studio.imageFormat jpeg|webp.
RUN apk add --no-cache imagemagick imagemagick-jpeg imagemagick-webp
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY package.json ./
COPY src ./src
COPY deploy/oracle/brand ./deploy/oracle/brand
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "--no-warnings", "src/index.js"]
