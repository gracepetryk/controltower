# Built by the caddy service in the root compose.yaml, which mounts the Caddyfile.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_MAPBOX_ACCESS_TOKEN
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /src/dist /srv
