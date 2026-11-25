FROM node:22-bookworm-slim

WORKDIR /app
RUN chown node:node /app
ENV NODE_ENV=production \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=3000

COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=4s --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"]
CMD ["node", "src/server.js"]
