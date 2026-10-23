# Single-container image: the Node.js control plane, SRS and goryu,
# supervised by docker/entrypoint.sh with the same readiness ordering as the
# systemd install (SRS starts only after /api/ready answers).
#
# Pinned media binaries match scripts/server-install.sh; bump both together.
# x86_64 only, like the native installer.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update -q \
    && apt-get install -y -q --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# No dependency lifecycle scripts: only the two native modules are built.
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3 zeromq
COPY . .
RUN npm run build && npm prune --omit=dev

FROM debian:bookworm-slim AS media
ARG SRS_RELEASE_TAG=v6.0-r2
ARG SRS_FILENAME=SRS-CentOS7-x86_64-6.0-r2.zip
ARG SRS_SHA256=8b654eccaf2d984dd87cb4f6c8663748922c1cb529de65f6d895ac3daade89a2
ARG SRT_RELEASE_TAG=v3.3.0
ARG SRT_SHA256=d978707390aaf410f917c7752ad85ba8436c409bc78d03b87a1a95e7fecfbd66
ARG FFMPEG_BUILD_TAG=ffmpeg-n7.1.4-7-gadcf20da26
ARG FFMPEG_FILENAME=ffmpeg-n7.1.4-7-gadcf20da26-linux64-gpl-7.1.tar.xz
ARG FFMPEG_SHA256=ce46c711e3ff79ae1e9318bf7daa54c77f41ce37b71010c44f4a0b38f1d7a29f
RUN apt-get update -q \
    && apt-get install -y -q --no-install-recommends curl ca-certificates unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
RUN set -eux; \
    mkdir -p /out/bin /out/lib; \
    curl -fsSL -o ffmpeg.tar.xz "https://github.com/live-miracles/bunryu/releases/download/${FFMPEG_BUILD_TAG}/${FFMPEG_FILENAME}"; \
    echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c -; \
    tar -xJf ffmpeg.tar.xz; \
    install -m 755 ffmpeg-*/bin/ffmpeg ffmpeg-*/bin/ffprobe /out/bin/; \
    curl -fsSL -o srs.zip "https://github.com/ossrs/srs/releases/download/${SRS_RELEASE_TAG}/${SRS_FILENAME}"; \
    echo "${SRS_SHA256}  srs.zip" | sha256sum -c -; \
    unzip -q srs.zip -d srs; \
    install -m 755 "$(find srs -type f -path '*/usr/local/srs/objs/srs' | head -1)" /out/bin/srs; \
    curl -fsSL -o relay.tar.gz "https://github.com/live-miracles/goryu/releases/download/${SRT_RELEASE_TAG}/goryu-linux-x86_64.tar.gz"; \
    echo "${SRT_SHA256}  relay.tar.gz" | sha256sum -c -; \
    mkdir relay; tar -xzf relay.tar.gz -C relay; \
    install -m 755 "$(find relay -type f -name goryu -perm -111 | head -1)" /out/bin/goryu; \
    if [ -d relay/lib ]; then install -m 755 relay/lib/* /out/lib/; fi

FROM node:22-bookworm-slim
# tini reaps orphaned ffmpeg processes and forwards signals; iproute2 provides
# `ss` for the output socket watchdog; curl is the SRS readiness gate.
RUN apt-get update -q \
    && apt-get install -y -q --no-install-recommends tini iproute2 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=media /out/bin/ /usr/local/bin/
# The relay's bundled libsrt/C++ runtime is loaded by the relay only
# (LD_LIBRARY_PATH in docker/entrypoint.sh), never registered system-wide.
COPY --from=media /out/lib/ /usr/local/lib/bunryu-srt/
COPY --from=build /app/package.json /app/srs.conf /app/goryu.json /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/public /app/public
COPY docker/entrypoint.sh /usr/local/bin/bunryu-entrypoint
RUN useradd --system --home /data --shell /usr/sbin/nologin bunryu \
    && mkdir -p /data && chown bunryu:bunryu /data
USER bunryu
WORKDIR /data
VOLUME /data
ENV NODE_ENV=production
# Dashboard/API, RTMP input, SRT input, SRT relay input.
EXPOSE 8080/tcp 21935/tcp 10080/udp 10081/udp
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/ready || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bunryu-entrypoint"]
