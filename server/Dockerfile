FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app/server

# server 目录是构建上下文；shared 通过 Compose additional_contexts 注入，
# 保持与仓库相同的 ../../../packages/shared 相对路径。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY --from=shared . /app/packages/shared

EXPOSE 8787
USER node

CMD ["npm", "start"]
