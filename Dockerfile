# Podcast Digest Bot — long-lived worker (Telegram long-polling, no inbound port).
# Caption-only transcript fetch (youtube-transcript) — no yt-dlp / ffmpeg needed.
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching. tsx is a runtime dep so prod can run .ts.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
CMD ["npm", "start"]
