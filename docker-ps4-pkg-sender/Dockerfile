FROM node:16.17-alpine as build

WORKDIR /pkg_sender

COPY package.json package.json
RUN npm install

FROM node:16.17-alpine

RUN apk --no-cache add curl

COPY --from=build /pkg_sender /
COPY src src

ENV PORT=7895 \
    STATIC_FILES=/files \
    CACHE_DIR=/cache \
    PS4PORT=12800

EXPOSE 7895

CMD ["npm", "start"]
