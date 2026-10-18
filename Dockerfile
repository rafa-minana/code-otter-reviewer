FROM node:24-alpine
ARG APP
RUN case "$APP" in \
      worker) apk add --no-cache git docker-cli ;; \
      reviewer) apk add --no-cache git ;; \
    esac
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN test -n "$APP" && npm ci && npx tsc -b apps/$APP && npm prune --omit=dev
ENV APP=$APP
USER node
CMD node apps/$APP/dist/index.js
