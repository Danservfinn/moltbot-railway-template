# Build openclaw from source to avoid npm packaging gaps (some dist files are not shipped).
FROM node:22-bookworm AS openclaw-build

# Dependencies needed for openclaw build
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Install Bun (openclaw build uses it)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /openclaw

# Pin to a known ref (tag/branch). If it doesn't exist, fall back to main.
ARG OPENCLAW_GIT_REF=main
RUN git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" https://github.com/openclaw/openclaw.git .

# Patch: relax version requirements for packages that may reference unpublished versions.
# Apply to all extension package.json files to handle workspace protocol (workspace:*).
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

RUN pnpm install --no-frozen-lockfile
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build


# Runtime image
FROM node:22-bookworm
ENV NODE_ENV=production
# Force Docker layer cache invalidation - updated to break Railway cache
ARG CACHEBUST=2026-02-03-06-00

# Install dependencies for the wrapper and tinyproxy (for Signal DNS resolution)
# tinyproxy handles HTTPS CONNECT and uses Google DNS (8.8.8.8) to resolve Signal's servers
# This bypasses Railway's DNS which cannot resolve textsecure-service.whispersystems.org
# Using GraalVM native build of signal-cli - NO Java runtime required!
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    build-essential \
    gcc \
    g++ \
    make \
    procps \
    file \
    git \
    python3 \
    pkg-config \
    sudo \
    tinyproxy \
  && which tinyproxy \
  && rm -rf /var/lib/apt/lists/*

# Configure tinyproxy for Signal server access
# Use only Port directive (Listen is not compatible with Port)
RUN printf 'Port 8888\nTimeout 600\nLogLevel Info\nMaxClients 100\nMinSpareServers 2\nMaxSpareServers 5\nStartServers 2\nAllow 127.0.0.1\nDisableViaHeader Yes\n' > /etc/tinyproxy/tinyproxy.conf \
  && cat /etc/tinyproxy/tinyproxy.conf
# Force new layer with LABEL
LABEL tinyproxy.configured="2026-02-03-06-00"

# Install signal-cli GraalVM native build (for Signal channel support)
# Native build does NOT require Java runtime!
# Version 0.13.18 using Linux-native.tar.gz for precompiled binary
# Note: Native build extracts to a single binary file at /opt/signal-cli, not a directory
# Force rebuild 2026-02-03-06-15
ARG SIGNAL_CLI_VERSION=0.13.18
RUN curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz" \
    | tar -xz -C /opt \
  && ln -sf /opt/signal-cli /usr/local/bin/signal-cli \
  && /usr/local/bin/signal-cli --version

# Install Homebrew (must run as non-root user)
# Create a user for Homebrew installation, install it, then make it accessible to all users
RUN useradd -m -s /bin/bash linuxbrew \
  && echo 'linuxbrew ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER linuxbrew
RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

USER root
RUN chown -R root:root /home/linuxbrew/.linuxbrew
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

WORKDIR /app

# Wrapper deps
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

# Copy built openclaw
COPY --from=openclaw-build /openclaw /openclaw

# Provide a openclaw executable
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

COPY src ./src

ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
# Cache bust 1770100900 Mon Feb  3 06:15:00 EST 2026 - Using signal-cli 0.13.18 native build (no Java required)
