# Butler agent for AgentCore Runtime (HTTP protocol, linux/arm64): POST /invocations and GET /ping on :8080.
# Only needed with `-c runtimeArtifact=container` (the default deployment is S3 direct code deployment, no Docker;
# see infra/README.md). Building this image needs Docker + buildx. Build from the repo root:
#   docker buildx build --platform linux/arm64 -f agent/Dockerfile -t butler-agent .
# Not built or run in CI.
FROM --platform=linux/arm64 python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 \
    PROMPTS_DIR=/app/prompts BUTLER_SEED_DIR=/app/seed
WORKDIR /app
# third-party dependencies first (cache-friendly), then the workspace packages without re-resolving them
RUN pip install pydantic httpx boto3 starlette uvicorn pyyaml cedarpy tzdata
COPY packages/contracts/py packages/contracts/py
COPY libs/butler_rules libs/butler_rules
COPY libs/butler_actions libs/butler_actions
COPY actions actions
COPY agent agent
RUN pip install --no-deps ./packages/contracts/py ./libs/butler_rules ./libs/butler_actions ./actions ./agent
COPY prompts prompts
COPY seed seed
# swaps in the Cognito client-credentials gateway client (the factory only knows the static local tokens)
COPY infra/runtime/agent_entry.py /app/agent_entry.py
EXPOSE 8080
CMD ["python", "/app/agent_entry.py"]
