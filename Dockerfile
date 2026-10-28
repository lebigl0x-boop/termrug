# The platform builder has to guess how to build a repository; this file states
# it instead, so the image that boots in production is the one described here.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies resolve in their own layer, so a code-only change does not
# reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# The process stays root: JsonStorage writes to data/, which in production is a
# mounted volume owned by root, and an unprivileged user could not write to it.
# PORT is read from the environment; EXPOSE only documents the default.
EXPOSE 3000
CMD ["node", "src/server.js"]
