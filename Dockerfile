# syntax=docker/dockerfile:1
FROM ubuntu:22.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Shanghai

# Install TeX Live (full) + ImageMagick + poppler + Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    # LaTeX
    texlive-full \
    texlive-latex-extra \
    # PDF → PNG conversion
    imagemagick \
    poppler-utils \
    ghostscript \
    # Node.js runtime
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Fix ImageMagick PDF policy (allow PDF read)
RUN sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' \
    /etc/ImageMagick-6/policy.xml || true

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json tsconfig.json ./
RUN npm install --omit=dev 2>/dev/null || npm install

# Copy source and build
COPY src/ ./src/
RUN npm run build

# Default: run MCP server via stdio
CMD ["node", "dist/index.js"]
