#!/bin/bash
# Ollama + qwen3-cqa на машине с GPU. Слушает внутренний адрес, порт 11434 снаружи закрыт файрволом.
set -e
export HOME=/root
if ! command -v ollama >/dev/null; then curl -fsSL https://ollama.com/install.sh | sh; fi
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<CONF
[Service]
Environment=OLLAMA_HOST=0.0.0.0:11434
Environment=OLLAMA_KEEP_ALIVE=-1
Environment=OLLAMA_CONTEXT_LENGTH=16384
Environment=OLLAMA_NUM_PARALLEL=2
CONF
systemctl daemon-reload && systemctl restart ollama
sleep 5
if ! ollama list | grep -q qwen3-cqa; then
  ollama pull qwen3:30b
  printf 'FROM qwen3:30b\nPARAMETER num_ctx 16384\nPARAMETER temperature 0.2\n' > /tmp/Modelfile
  ollama create qwen3-cqa -f /tmp/Modelfile
fi
# прогрев: загрузить модель в GPU сразу после старта машины
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"qwen3-cqa","prompt":"ok","stream":false,"options":{"num_predict":1}}' >/dev/null || true
