# Build context = the staged tree made by `cloudctl.py stage` (tools/lod2/*.py, tools/cph-geodata/frame.py, tools/cloud/roofer/*).
# roofer 3dgi/roofer:v1.1.0-beta.1 (tools/lod2/common.ROOFER_IMAGE), pinned by its multi-arch index digest; Ubuntu 24.04.
FROM 3dgi/roofer@sha256:476b5f4bbaf4109c52fe7fba1e81a9ece0ef4ade557dbdadb79b318444689e99
USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# PDAL is not packaged for Ubuntu 24.04: conda-forge build in its own prefix (rpath'd, does not touch roofer's libraries)
COPY --from=mambaorg/micromamba:2.0.5 /bin/micromamba /usr/local/bin/micromamba
RUN micromamba create -y -p /opt/pdal -c conda-forge pdal && micromamba clean -afy
ENV PATH=/opt/pdal/bin:$PATH PROJ_DATA=/opt/pdal/share/proj GDAL_DATA=/opt/pdal/share/gdal
COPY tools/cloud/roofer/requirements.txt /tmp/requirements.txt
RUN /usr/bin/python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
COPY tools/lod2/common.py tools/lod2/prep.py tools/lod2/fetch.py tools/lod2/convert.py /app/tools/lod2/
COPY tools/cph-geodata/frame.py /app/tools/cph-geodata/frame.py
COPY tools/cloud/roofer/task.py tools/cloud/roofer/lidar_r2.py tools/cloud/roofer/r2_credentials.py /app/tools/cloud/roofer/
WORKDIR /work
ENTRYPOINT ["/opt/venv/bin/python", "/app/tools/cloud/roofer/task.py"]
