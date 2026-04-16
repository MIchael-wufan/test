# syntax=docker/dockerfile:1
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Shanghai

# texlive-plain-generic → xlop.sty
# texlive-science       → longdivision.sty
# 替换 apt 源为阿里云镜像，避免 archive.ubuntu.com 在 Railway 构建环境中不可达
RUN sed -i 's|http://archive.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g' /etc/apt/sources.list \
    && sed -i 's|http://security.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g' /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    texlive-latex-base \
    texlive-latex-extra \
    texlive-latex-recommended \
    texlive-fonts-recommended \
    texlive-plain-generic \
    texlive-science \
    pdf2svg \
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
