# Developer image (the installed recipe inlines the same source into a pinned python:3.12-alpine instead).
FROM python:3.12-alpine@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4
WORKDIR /app
COPY app /app/app
COPY web /app/web
COPY openapi.json /app/openapi.json
USER 1000:1000
ENV PORT=18818 PYTHONDONTWRITEBYTECODE=1
EXPOSE 18818
CMD ["python", "/app/app/server.py"]
