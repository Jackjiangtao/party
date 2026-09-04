FROM docker.1ms.run/library/node:20-alpine
WORKDIR /app
COPY server.mjs config.json ./
COPY public ./public
ENV PORT=8788 HOST=0.0.0.0
EXPOSE 8788
CMD ["node", "server.mjs"]
