FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git openssh-client ca-certificates curl bash ripgrep sudo nano tmux \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI — so agents can `gh issue create`, open PRs, etc. (authenticated at runtime).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash dev \
  && echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

RUN printf '#!/usr/bin/env bash\nexit 0\n' > /usr/local/bin/xdg-open \
  && chmod +x /usr/local/bin/xdg-open

RUN curl -fsSL -o /usr/local/bin/ttyd \
  https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
  && chmod +x /usr/local/bin/ttyd

RUN npm install -g opencode-ai

COPY entrypoint.sh /entrypoint.sh
COPY scripts/ /usr/local/share/opencode-phone/
RUN chmod +x /entrypoint.sh /usr/local/share/opencode-phone/* \
  && ln -sf /usr/local/share/opencode-phone/agent-done /usr/local/bin/agent-done \
  && ln -sf /usr/local/share/opencode-phone/agent-failed /usr/local/bin/agent-failed \
  && ln -sf /usr/local/share/opencode-phone/agent-run /usr/local/bin/agent-run \
  && ln -sf /usr/local/share/opencode-phone/mark-session-status /usr/local/bin/mark-session-status

WORKDIR /

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
