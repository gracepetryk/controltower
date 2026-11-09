# Built by the web service in the root compose.yaml. Running it replaces the
# contents of /srv with the build, for Caddy to serve from a shared volume.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_MAPBOX_ACCESS_TOKEN
RUN npm run build

FROM busybox:latest
COPY --from=build /src/dist /dist
CMD ["sh", "-c", "find /srv -mindepth 1 -delete && cp -a /dist/. /srv/"]
