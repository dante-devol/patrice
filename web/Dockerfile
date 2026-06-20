# Patrice web image: build the Angular app, serve static files via nginx with an
# API reverse-proxy (so the browser sees one origin and cookies travel cleanly).
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/patrice-web/browser /usr/share/nginx/html
EXPOSE 80
