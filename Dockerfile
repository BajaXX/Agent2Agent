# Agent2Agent 平台 — 服务端镜像
# 选 node:22-slim（Debian 系）而非 alpine：better-sqlite3 有 glibc 预编译二进制，免源码编译
FROM node:22-slim

# better-sqlite3 需要源码编译的兜底工具链（无预编译包时 node-gyp 编译用）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --no-audit --no-fund

# 拷贝源码与静态资源
COPY server server
COPY cli cli
COPY web web
COPY docs docs

# 数据目录由外部卷挂载（compose 中 A2A_DATA_DIR=/data），这里创建兜底目录
ENV A2A_DATA_DIR=/data \
    A2A_PORT=3081 \
    A2A_HOST=0.0.0.0
RUN mkdir -p /data

EXPOSE 3081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3081/api/v1/summary').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

CMD ["node", "server/src/index.js"]
