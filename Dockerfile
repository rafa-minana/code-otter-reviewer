# One image per app: docker build --build-arg APP=api|worker|reviewer .
FROM node:24-alpine
ARG APP
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN test -n "$APP" && npm ci && npx tsc -b apps/$APP && npm prune --omit=dev
ENV APP=$APP
USER node
CMD node apps/$APP/dist/index.js
