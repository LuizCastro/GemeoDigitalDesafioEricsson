import cv2
import requests
import time
import os
from datetime import datetime
from ultralytics import YOLO

# --- CONFIGURAÇÕES E CONTRATO DE DADOS ---
# [cite: 10, 40]
API_URL = "http://localhost:3000/api/alert"  # URL da API do backend
AUTH_TOKEN = os.getenv(
    "EDGE_AUTH_TOKEN",
    os.getenv("AUTH_TOKEN", "GEMEO_DIGITAL_5G_ERICSSON_2026_9f3a27c1")
)
INCIDENT_ALERTS_ENABLED = os.getenv("EDGE_INCIDENT_ALERTS_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
REQUEST_HEADERS = {
    "Authorization": f"Bearer {AUTH_TOKEN}",
    "Content-Type": "application/json",
}

# [cite: 42]
# Modelo treinado pelo Squad 1 (notebook: smoke-fire-detection-yolo-v12)
# Execute: python edge/download_model.py  para baixar/gerar o best.pt
MODEL_PATH = 'edge/models/best.pt'

# Classes do modelo treinado (conforme validacao no Kaggle):
#   {0: 'smoke', 1: 'fire'}   <- modelo Squad 1 (best.pt)
# Se usar COCO fallback (yolov8n_fallback.pt), nenhum label abaixo sera encontrado
# e o sistema ficara em modo normal — comportamento correto para demo.
TARGET_LABELS = ["smoke", "fire", "fogo", "fumaca"]

# Normaliza os labels para o contrato JSON do backend
LABEL_TO_EVENTO = {
    "fire":   "fogo",
    "fogo":   "fogo",
    "smoke":  "fumaca",
    "fumaca": "fumaca",
}

CONFIRMATION_FRAMES  = 5    # Frames consecutivos para validar o alerta
CONFIDENCE_THRESHOLD = 0.5  # [cite: 34]
HEARTBEAT_INTERVAL   = 3.0  # Segundos entre updates de posição normal

# Rota de patrulha do AMR — em produção substituir por GPS/odometria real
# Ordem: A → B → D → C → A (loop)
PATROL_PATH = [
    {"setor": "Setor A - Turbinas",            "x": 150, "y": 125},
    {"setor": "Setor B - Geradores",           "x": 360, "y": 125},
    {"setor": "Setor D - Caldeiras Químicas",  "x": 360, "y": 285},
    {"setor": "Setor C - Painéis de Controlo", "x": 150, "y": 285},
]

# --- ESTADO DO SISTEMA ---
consecutive_detections = 0
last_event = None


# [cite: 37, 41]
def start_inference():
    global consecutive_detections, last_event

    # 1. Carrega o modelo (Atividade 2.1)
    model = YOLO(MODEL_PATH)

    # 2. Inicia captura de video do robo (AMR) [cite: 39, 41]
    cap = cv2.VideoCapture(0)  # 0 para webcam ou caminho do video/stream

    print("Iniciando monitoramento em tempo real...")

    patrol_idx     = 0
    last_heartbeat = time.time()

    while cap.isOpened():
        success, frame = cap.read()
        if not success:
            break

        # 3. Execucao da Inferencia [cite: 39]
        results = model(frame, conf=CONFIDENCE_THRESHOLD, verbose=False)

        detected_this_frame = False
        current_conf = 0

        # Processa as deteccoes do frame atual
        for r in results:
            for box in r.boxes:
                cls   = int(box.cls[0])
                label = model.names[cls].lower()

                # Filtra apenas classes de fogo/fumaca
                if label in TARGET_LABELS:
                    detected_this_frame = True
                    last_event   = LABEL_TO_EVENTO.get(label, label)
                    current_conf = float(box.conf[0])

                    # Desenha na tela para o operador local [cite: 47]
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    color = (0, 0, 255) if last_event == "fogo" else (128, 128, 128)
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    cv2.putText(frame, f"{last_event} {current_conf:.2f}", (x1, y1 - 10),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

        # 4. Filtro Temporal (Atividade 2.2) [cite: 43, 44]
        if detected_this_frame:
            consecutive_detections += 1
        else:
            consecutive_detections = 0  # Reseta se houver um frame limpo

        # ── Heartbeat de patrulha — envia posição normal a cada HEARTBEAT_INTERVAL s ──
        # Garante que o dashboard mostre o robô em movimento mesmo sem incidentes.
        now = time.time()
        if now - last_heartbeat >= HEARTBEAT_INTERVAL:
            loc = PATROL_PATH[patrol_idx]
            payload_normal = {
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "evento": "normal",
                "confianca": 0.0,
                "localizacao_otimizada": loc,
                "llm_prompt": f"Patrulha de rotina no {loc['setor']}. Leituras térmicas normais."
            }
            try:
                requests.post(API_URL, json=payload_normal, headers=REQUEST_HEADERS, timeout=0.5)
                print(f"🔵 Heartbeat: {loc['setor']}")
            except Exception as e:
                print(f"Erro ao enviar heartbeat: {e}")
            patrol_idx     = (patrol_idx + 1) % len(PATROL_PATH)
            last_heartbeat = now

        # 5. Geracao de Telemetria de Alerta (Atividade 2.3) [cite: 45, 46]
        if consecutive_detections >= CONFIRMATION_FRAMES:
            loc = PATROL_PATH[patrol_idx]  # Setor atual do AMR no momento do alerta

            # Estrutura exata do Contrato JSON [cite: 15-20]
            payload = {
                "id_alerta": f"ALRT-{int(time.time()) % 10000}",
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "evento": last_event,
                "confianca": round(current_conf, 2),
                "localizacao_otimizada": loc,
                "llm_prompt": f"Gerar report urgente: {last_event.upper()} detectado no {loc['setor']}."
            }

            if INCIDENT_ALERTS_ENABLED:
                # Dispara o alerta para o backend quando explicitamente habilitado.
                try:
                    response = requests.post(API_URL, json=payload, headers=REQUEST_HEADERS, timeout=0.5)
                    print(f"🚨 Alerta enviado! Status: {response.status_code}")
                except Exception as e:
                    print(f"Erro ao conectar com backend: {e}")
            else:
                print(f"🟡 Incidente detectado localmente ({last_event}), mas envio HTTP desabilitado.")

            # Reseta o contador apos o envio para evitar spam
            consecutive_detections = 0

        # Exibicao do processamento (Inference Visual) [cite: 47]
        cv2.imshow("AMR Vision - Fire Detection", frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    start_inference()