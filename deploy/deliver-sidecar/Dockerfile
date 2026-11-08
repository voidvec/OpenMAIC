# aliyunpan sidecar
#
# 为什么要有这个容器：
#   1. render-service 默认 RENDER_EGRESS_LOCKDOWN=true，出站被 iptables DROP，自己发不出请求
#   2. OpenMAIC 上游没有任何网盘能力，而官方阿里云盘 OpenAPI 需要人工审核的应用凭据
#   3. 所以把 aliyunpan CLI 关进一个独立容器，只暴露最小的 HTTP 接口给 Next 侧调用
#
# 二进制预置在 bin/ 下（build 时不联网，避免国内直连 GitHub 失败）
FROM m.daocloud.io/docker.io/library/node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY bin/aliyunpan /usr/local/bin/aliyunpan
RUN chmod 0755 /usr/local/bin/aliyunpan

WORKDIR /app
COPY server.mjs /app/server.mjs

# ALIYUNPAN_CONFIG_DIR 指向挂载进来的登录态目录（aliyunpan_config.json）
ENV NODE_ENV=production \
    ALIYUNPAN_CONFIG_DIR=/config \
    ALIYUNPAN_VERBOSE=0 \
    DELIVER_PORT=8099

EXPOSE 8099

CMD ["node", "/app/server.mjs"]
