# Build context = the tree staged by `cloudctl.py build` (tools/cph-geodata/*.py used by the appearance pass, the skraafoto helper, tools/cloud/skraafoto/task.py).
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 NUMBA_CACHE_DIR=/tmp/numba
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libexpat1 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY tools/cloud/skraafoto/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY tools/cph-geodata/ /app/tools/cph-geodata/
COPY .claude/skills/building-case-to-3d/scripts/skraafoto.py /app/.claude/skills/building-case-to-3d/scripts/skraafoto.py
COPY tools/cloud/skraafoto/task.py /app/tools/cloud/skraafoto/task.py
WORKDIR /app
ENTRYPOINT ["python", "/app/tools/cloud/skraafoto/task.py"]
