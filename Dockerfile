# syntax=docker/dockerfile:1
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Shanghai

# texlive-plain-generic → xlop.sty
# texlive-science       → longdivision.sty
RUN apt-get update && apt-get install -y --no-install-recommends \
    texlive-latex-base \
    texlive-latex-extra \
    texlive-latex-recommended \
    texlive-fonts-recommended \
    texlive-plain-generic \
    texlive-science \
    poppler-utils \
    ghostscript \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 覆盖系统 longdivision.sty（横线延伸到被除数全宽，符合中国书写规范）
COPY texmf/longdivision.sty /usr/share/texmf/tex/latex/longdivision/longdivision.sty
RUN mktexlsr

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npm run build

CMD ["node", "dist/index.js"]
