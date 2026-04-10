# syntax=docker/dockerfile:1
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Shanghai

# Install minimal LaTeX (xlop + longdivision only need basic + extra) + tools + Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Minimal LaTeX — covers xlop and longdivision packages
    texlive-latex-base \
    texlive-latex-extra \
    texlive-latex-recommended \
    texlive-fonts-recommended \
    # PDF → PNG
    poppler-utils \
    ghostscript \
    # Node.js
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install xlop and longdivision via tlmgr
RUN tlmgr init-usertree && tlmgr install xlop longdivision || true

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npm run build

CMD ["node", "dist/index.js"]
