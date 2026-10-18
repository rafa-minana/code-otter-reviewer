FROM node:24-alpine
ARG APP
ARG TARGETARCH
# Not packaged by Alpine: the official release, pinned by checksum (the build fails if it doesn't match).
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256_X64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
RUN case "$APP" in \
      worker) apk add --no-cache git docker-cli ;; \
      reviewer) apk add --no-cache git ripgrep \
        && case "$TARGETARCH" in \
             arm64) arch=arm64 sha=$GITLEAKS_SHA256_ARM64 ;; \
             *) arch=x64 sha=$GITLEAKS_SHA256_X64 ;; \
           esac \
        && wget -qO /tmp/gitleaks.tgz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz" \
        && echo "$sha  /tmp/gitleaks.tgz" | sha256sum -c - \
        && tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks \
        && rm /tmp/gitleaks.tgz ;; \
    esac
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN test -n "$APP" && npm ci && npx tsc -b apps/$APP && npm prune --omit=dev
ENV APP=$APP
USER node
CMD node apps/$APP/dist/index.js
