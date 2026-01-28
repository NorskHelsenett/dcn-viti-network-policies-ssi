FROM denoland/deno:alpine

ENV CONFIG_PATH=/app/config/config.yaml
ENV SECRETS_PATH=/app/secrets/secrets.yaml

WORKDIR /app

# Packages for runtime (git) + TLS
USER root
RUN apk add --no-cache git ca-certificates && update-ca-certificates

# Add internal CA properly (Alpine)
COPY ./nhn_internal_ca_chain.crt /usr/local/share/ca-certificates/nhn_internal_ca_chain.crt
RUN update-ca-certificates

# Copy source
COPY . .

# Deno deps/cache
RUN deno install --allow-scripts=npm:unix-dgram@2.0.6
RUN deno cache main.ts

# Optional: tests (avoid real secrets during build if possible)
RUN deno task test

# Prepare dirs (mostly useful for local docker runs; k8s volumes override)
RUN mkdir -p /app/logs /app/config /app/secrets \
 && touch /app/logs/.keep /app/config/.keep /app/secrets/.keep \
 && chown -R deno:deno /app

USER deno
CMD ["deno", "task", "unsafe"]

# Cleanup secrets after build tests and run, comment out to run locally in docker.
RUN rm -f /app/config/*
RUN rm -f /app/secrets/*