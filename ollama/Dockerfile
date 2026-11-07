# Ollama + Qwen3 30B (qwen3-cqa, контекст 16K) для Cloud Run с GPU NVIDIA L4.
# Веса модели запекаются в образ, чтобы холодный старт не качал 18 ГБ из интернета.
FROM ollama/ollama:latest
ENV OLLAMA_HOST=0.0.0.0:8080 \
    OLLAMA_MODELS=/models \
    OLLAMA_KEEP_ALIVE=-1 \
    OLLAMA_CONTEXT_LENGTH=16384 \
    OLLAMA_NUM_PARALLEL=1
COPY Modelfile /tmp/Modelfile
RUN ollama serve & pid=$! ; sleep 5 \
 && ollama pull qwen3:30b \
 && ollama create qwen3-cqa -f /tmp/Modelfile \
 && kill $pid
ENTRYPOINT ["ollama", "serve"]
