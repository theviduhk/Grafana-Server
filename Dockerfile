# Render / any Docker host. Ships Chromium + its system libraries for the Trax monitor (MODE 8).
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
# npm installs the playwright version from package.json; "playwright install" then fetches the
# matching Chromium build and the OS libraries it needs (libnss3, libgbm, ...), so they can never mismatch.
RUN npm install --omit=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# server.js, dashboard.html, planning.html (see .dockerignore)
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
