# One image per app: docker build --build-arg APP=api|worker|reviewer .
FROM node:24-alpine
ARG APP
# The worker clones and checks out PRs; the reviewer (v1) reads history. The api never runs git.
RUN if [ "$APP" != "api" ]; then apk add --no-cache git; fi
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN test -n "$APP" && npm ci && npx tsc -b apps/$APP && npm prune --omit=dev
ENV APP=$APP
USER node
CMD node apps/$APP/dist/index.js
