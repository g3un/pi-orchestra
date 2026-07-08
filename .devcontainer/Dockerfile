FROM node:lts-slim AS node
FROM debian:13

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        sudo \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm config set ignore-scripts true

RUN groupadd --gid 1000 dev \
    && useradd --uid 1000 --gid dev --create-home --shell /bin/bash dev \
    && printf '%s\n' 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev \
    && chmod 0440 /etc/sudoers.d/dev

RUN install -d -m 0755 -o dev -g dev /nix \
    && mkdir -p /etc/nix \
    && printf '%s\n' \
        'build-users-group =' \
        'experimental-features = nix-command flakes' \
        'eval-cache = false' \
        > /etc/nix/nix.conf

USER dev
ENV HOME=/home/dev USER=dev
RUN npm config set ignore-scripts true \
    && git config --global init.defaultBranch main \
    && git config --global push.autoSetupRemote true \
    && curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install | sh -s -- --no-daemon

USER root
RUN ln -sf /home/dev/.nix-profile/bin/nix /usr/local/bin/nix \
    && printf '%s\n' \
        'case "$-" in' \
        '  *i*)' \
        '    if [ -z "${IN_NIX_SHELL:-}" ] && [ -f flake.nix ]; then' \
        '      exec nix develop "path:$PWD" --command bash -l' \
        '    fi' \
        '    ;;' \
        'esac' \
        > /home/dev/.bash_profile \
    && chown dev:dev /home/dev/.bash_profile

USER dev
