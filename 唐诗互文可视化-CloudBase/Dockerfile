FROM python:3.12-slim
WORKDIR /app
COPY . .
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
USER 65534:65534
CMD ["python", "-B", "serve.py", "--cloud", "--source", "/app/data"]
