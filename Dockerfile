# Podcast Digest Bot — long-lived worker (Telegram long-polling, no inbound port)
FROM node:20-slim

# yt-dlp (self-contained linux build) gives us video duration + transcripts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
       -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. tsx is a runtime dep so prod can run .ts.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
CMD ["npm", "start"]
