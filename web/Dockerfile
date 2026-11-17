# SOMA in the browser as a container: one container per user (web/README.md). Build from the root of the repository:
#   docker build -f web/Dockerfile -t soma-web .
#   docker run -p 5173:5173 -v soma-data:/home/node soma-web
# The server prints the address with its token in the log (docker logs). Models, settings and agents' logins are in
# /home/node, keep it on a volume. Agents such as Claude Code are not included: install them in the container's terminal
# (npm install -g …) or in an image of your own on top of this one.

# ---- Build: the web version and app/'s runtime packages (node-pty is built here, it needs a compiler) -------------------
FROM node:22-bookworm AS build
WORKDIR /src
# Electron itself is not needed: only its packages for the renderer and the main process
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY app/package.json app/package-lock.json app/
RUN cd app && npm ci --no-audit --no-fund
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund --omit=dev
COPY app app
COPY web web
RUN cd web && node build.mjs && cd ../app && npm prune --omit=dev --no-audit --no-fund

# ---- Python: CadQuery, soma and CalculiX, pinned as for the desktop app (python/requirements-base.txt) -----------------
FROM debian:bookworm-slim AS python
ENV UV_PYTHON_INSTALL_DIR=/opt/soma/python UV_LINK_MODE=copy
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9.8 /uv /usr/local/bin/uv
COPY python /src/python
RUN uv venv --python 3.12 /opt/soma/venv \
 && uv pip install --python /opt/soma/venv/bin/python -r /src/python/requirements-base.txt \
 && uv pip install --python /opt/soma/venv/bin/python /src/python \
 && /opt/soma/venv/bin/python /src/python/scripts/fetch_ccx.py

# ---- Runtime --------------------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim
# git for the terminals and agents (the app's own Git comes with dugite); the libraries gmsh and VTK load (FEM, meshes)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git bash less procps libgl1 libglu1-mesa libxrender1 libxft2 libxinerama1 libxcursor1 libxext6 libsm6 libice6 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=python /opt/soma /opt/soma
# app/ with its runtime packages (node-pty, dugite, pi), web/ with the built server and pages
COPY --from=build /src/app /opt/soma/app/app
COPY --from=build /src/web /opt/soma/app/web
COPY LICENSE THIRD_PARTY_NOTICES.md /opt/soma/app/
# The user of the image: `node` (uid 1000) that the base image has, the slim image has no tools to add another
USER node
WORKDIR /home/node
ENV SOMA_PYTHON=/opt/soma/venv/bin/python \
    PATH=/home/node/.npm-global/bin:/opt/soma/venv/bin:$PATH \
    SOMA_USER_DATA=/home/node/.soma-web \
    NPM_CONFIG_PREFIX=/home/node/.npm-global \
    SOMA_WEB_HOST=0.0.0.0 \
    SOMA_WEB_PORT=5173 \
    SHELL=/bin/bash
EXPOSE 5173
CMD ["node", "/opt/soma/app/web/bin/soma-web.cjs"]
