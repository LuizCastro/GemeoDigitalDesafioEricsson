import cv2
import requests
import time
import os
import json
import threading
import numpy as np
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from ultralytics import YOLO

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MONITORING_STATE_PATH = os.path.join(BASE_DIR, 'monitoring_state.json')


def _get_env_int(name, default):
    value = os.getenv(name, '').strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        print(f"⚠️  Valor inválido para {name}: {value!r}. Usando {default}.")
        return default


def _utc_timestamp():
    return datetime.now(UTC).isoformat().replace('+00:00', 'Z')

# ── MJPEG Stream Server (porta 3002) ──
STREAM_PORT = 3002
STREAM_MAX_FPS = max(1, _get_env_int('EDGE_STREAM_MAX_FPS', 12))
_output_frame = None
_frame_lock   = threading.Lock()


class _ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """MJPEG server que cria uma thread por conexão."""
    daemon_threads = True


class _MJPEGHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # silencia logs HTTP no terminal

    def _send_stream_headers(self):
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()

    def do_HEAD(self):
        if self.path == '/video_feed':
            self._send_stream_headers()
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        if self.path == '/video_feed':
            self._send_stream_headers()
            try:
                while True:
                    with _frame_lock:
                        frame_bytes = _output_frame
                    if frame_bytes is not None:
                        self.wfile.write(
                            b'--frame\r\n'
                            b'Content-Type: image/jpeg\r\n\r\n' +
                            frame_bytes +
                            b'\r\n'
                        )
                        self.wfile.flush()
                    time.sleep(1 / STREAM_MAX_FPS)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        else:
            self.send_response(404)
            self.end_headers()


def _start_mjpeg_server():
    server = _ThreadedHTTPServer(('0.0.0.0', STREAM_PORT), _MJPEGHandler)
    print(f"\u2705 MJPEG stream disponível em: http://localhost:{STREAM_PORT}/video_feed")
    server.serve_forever()

# --- CONFIGURAÇÕES E CONTRATO DE DADOS ---
# [cite: 10, 40]
API_URL = "http://localhost:3000/api/alert"  # URL da API do backend
AUTH_TOKEN = os.getenv(
    "EDGE_AUTH_TOKEN",
    os.getenv("AUTH_TOKEN", "GEMEO_DIGITAL_5G_ERICSSON_2026_9f3a27c1")
)
REQUEST_HEADERS = {
    "Authorization": f"Bearer {AUTH_TOKEN}",
    "Content-Type": "application/json",
}

# [cite: 42]
# Modelo treinado pelo Squad 1 (notebook: smoke-fire-detection-yolo-v12)
# Execute: python edge/download_model.py  para baixar/gerar o best.pt
PRIMARY_MODEL_PATH = os.path.join(BASE_DIR, 'models', 'best.pt')
FALLBACK_MODEL_PATH = os.path.join(BASE_DIR, 'models', 'yolov8n_fallback.pt')

# ── FONTE DE VÍDEO ──────────────────────────────────────────────────────────
# Prioridade de resolução (do mais específico para o mais genérico):
#   1. Variável de ambiente VIDEO_SOURCE
#   2. Arquivo de vídeo local  edge/sample.mp4  (coloque qualquer vídeo aqui)
#   3. Stream RTSP              rtsp://IP_AMR/stream
#   4. Webcam padrão            0
#
# Para trocar sem editar código:
#   set VIDEO_SOURCE=0                          (webcam)
#   set VIDEO_SOURCE=edge\meu_video.mp4         (arquivo)
#   set VIDEO_SOURCE=rtsp://192.168.1.10/stream (AMR real)
# ────────────────────────────────────────────────────────────────────────────
_SAMPLE_VIDEO = os.path.join(BASE_DIR, 'sample.mp4')

def _resolve_video_source() -> object:
    """Retorna o argumento correto para cv2.VideoCapture."""
    env_src = os.getenv('VIDEO_SOURCE', '').strip()
    if env_src:
        # Tenta converter para int (índice de câmara) se for número
        return int(env_src) if env_src.isdigit() else env_src
    if os.path.exists(_SAMPLE_VIDEO):
        print(f"📹 Usando vídeo de simulação: {_SAMPLE_VIDEO}")
        return _SAMPLE_VIDEO
    print("📷 VIDEO_SOURCE não definido e sample.mp4 não encontrado — usando webcam (índice 0)")
    return 0

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
CLEAR_FRAMES_TO_REARM = 15  # Frames limpos para permitir um novo alerta
PAUSE_POLL_INTERVAL = 0.5
INFERENCE_WIDTH = max(320, _get_env_int('EDGE_INFERENCE_WIDTH', 512))
STREAM_WIDTH = max(320, _get_env_int('EDGE_STREAM_WIDTH', 640))
JPEG_QUALITY = min(95, max(30, _get_env_int('EDGE_JPEG_QUALITY', 70)))
PUBLISH_MAX_FPS = max(1, _get_env_int('EDGE_PUBLISH_MAX_FPS', 8))
PROCESS_EVERY_N_FRAMES = max(1, _get_env_int('EDGE_PROCESS_EVERY_N_FRAMES', 2))

# Rota de patrulha do AMR — em produção substituir por GPS/odometria real
# Ordem: A → B → D → C → A (loop)
PATROL_PATH = [
    {"setor": "Setor A - Turbinas",            "x": 150, "y": 125},
    {"setor": "Setor B - Geradores",           "x": 360, "y": 125},
    {"setor": "Setor D - Caldeiras Químicas",  "x": 360, "y": 285},
    {"setor": "Setor C - Painéis de Controle", "x": 150, "y": 285},
]

# --- ESTADO DO SISTEMA ---
consecutive_detections = 0
last_event = None
alert_latched = False
clear_frames_since_alert = 0


def send_heartbeat(patrol_idx):
    loc = PATROL_PATH[patrol_idx]
    payload_normal = {
        "timestamp": _utc_timestamp(),
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


def _publish_stream_frame(frame, paused=False):
    stream_frame = cv2.resize(frame, (STREAM_WIDTH, int(frame.shape[0] * (STREAM_WIDTH / frame.shape[1])))) if frame.shape[1] > STREAM_WIDTH else frame.copy()
    if paused:
        cv2.putText(
            stream_frame,
            'MONITORAMENTO PAUSADO',
            (20, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.0,
            (0, 165, 255),
            2,
        )
    ok, buf = cv2.imencode('.jpg', stream_frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if ok:
        with _frame_lock:
            global _output_frame
            _output_frame = buf.tobytes()


def _publish_status_frame(title, detail=''):
    frame = np.zeros((360, STREAM_WIDTH, 3), dtype=np.uint8)
    cv2.putText(frame, title, (20, 80), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 165, 255), 2)
    if detail:
        cv2.putText(frame, detail[:70], (20, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    _publish_stream_frame(frame)


def run_heartbeat_only(reason="sem modelo ou sem camera"):
    print(f"Modo heartbeat-only ativo: {reason}, sem inferencia local.")
    patrol_idx = 0
    while True:
        _publish_status_frame('MONITORAMENTO LIMITADO', reason)
        send_heartbeat(patrol_idx)
        patrol_idx = (patrol_idx + 1) % len(PATROL_PATH)
        time.sleep(HEARTBEAT_INTERVAL)


def _write_monitoring_state(mode, reason):
    with open(MONITORING_STATE_PATH, 'w', encoding='utf-8') as file_handle:
        json.dump({
            'mode': mode,
            'reason': reason,
            'updated_at': _utc_timestamp(),
        }, file_handle)


def _read_monitoring_mode():
    try:
        with open(MONITORING_STATE_PATH, 'r', encoding='utf-8') as file_handle:
            return json.load(file_handle).get('mode', 'running')
    except Exception:
        return 'running'


def _pause_until_resumed():
    """Pausa o processamento até que o estado seja alterado para 'running'."""
    try:
        while True:
            try:
                with open(MONITORING_STATE_PATH, 'r') as f:
                    state = json.load(f)
                if state.get('mode') == 'running':
                    print("🟢 Monitoramento retomado.")
                    break
            except Exception as e:
                print(f"⚠️  Erro ao ler estado de monitoramento: {e}")
            print("⏸️  Sistema pausado. Aguardando retomada...")
            time.sleep(1)  # Aguarda 1 segundo antes de verificar novamente
    except KeyboardInterrupt:
        print("🔴 Interrupção detectada. Encerrando o sistema...")
        raise
    return time.time()  # retorna timestamp para reiniciar o heartbeat corretamente

def _handle_alert():
    """Lógica para lidar com alertas e pausar o sistema."""
    print("⏸️  Alerta emitido. Pausando monitoramento...")
    _pause_until_resumed()


# [cite: 37, 41]
def start_inference():
    global consecutive_detections, last_event, alert_latched, clear_frames_since_alert, _output_frame

    _write_monitoring_state('running', 'edge-startup')

    # Inicia servidor MJPEG cedo para manter a rota do video acessivel
    mjpeg_thread = threading.Thread(target=_start_mjpeg_server, daemon=True)
    mjpeg_thread.start()
    _publish_status_frame('INICIANDO EDGE', 'aguardando modelo/camera')

    # 1. Carrega o modelo (Atividade 2.1)
    model_path = PRIMARY_MODEL_PATH if os.path.exists(PRIMARY_MODEL_PATH) else FALLBACK_MODEL_PATH
    if not os.path.exists(model_path):
        print("Nenhum modelo encontrado. Iniciando somente heartbeat de patrulha.")
        run_heartbeat_only('modelo nao encontrado')
        return

    print(f"Carregando modelo: {model_path}")
    model = YOLO(model_path)

    # 2. Inicia captura de video do robo (AMR) [cite: 39, 41]
    video_source = _resolve_video_source()
    is_file = isinstance(video_source, str) and os.path.isfile(video_source)
    cap = cv2.VideoCapture(video_source)
    if not cap.isOpened():
        print(f"Fonte de vídeo '{video_source}' indisponível. Iniciando somente heartbeat de patrulha.")
        run_heartbeat_only(f'fonte de video indisponivel: {video_source}')
        return

    source_label = "arquivo" if is_file else ("RTSP" if isinstance(video_source, str) else "webcam")
    print(f"Iniciando monitoramento em tempo real... [fonte: {source_label} → {video_source}]")
    print(
        "Modo econômico ativo: "
        f"infer_width={INFERENCE_WIDTH}, stream_width={STREAM_WIDTH}, "
        f"jpeg={JPEG_QUALITY}, publish_fps={PUBLISH_MAX_FPS}, "
        f"stream_fps={STREAM_MAX_FPS}, frame_skip={PROCESS_EVERY_N_FRAMES - 1}"
    )

    patrol_idx     = 0
    # Inicializar last_heartbeat com o timestamp atual
    last_heartbeat = time.time()
    last_publish_at = 0.0
    frame_index = 0

    while cap.isOpened():
        success, frame = cap.read()
        if not success:
            if is_file:
                # Loop no vídeo: volta ao início quando termina
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue
            break  # stream/webcam sem sinal → encerra

        frame_index += 1

        now = time.time()
        if now - last_heartbeat >= HEARTBEAT_INTERVAL:
            send_heartbeat(patrol_idx)
            patrol_idx     = (patrol_idx + 1) % len(PATROL_PATH)
            last_heartbeat = now

        if now - last_publish_at >= (1 / PUBLISH_MAX_FPS):
            _publish_stream_frame(frame)
            last_publish_at = now

        if frame_index % PROCESS_EVERY_N_FRAMES != 0:
            continue

        # 3. Execucao da Inferencia [cite: 39]
        # Redimensiona para inferência (mais rápido no CPU)
        infer_frame = cv2.resize(frame, (INFERENCE_WIDTH, int(frame.shape[0] * (INFERENCE_WIDTH / frame.shape[1])))) if frame.shape[1] > INFERENCE_WIDTH else frame
        results = model(infer_frame, conf=CONFIDENCE_THRESHOLD, verbose=False)

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

                    # Desenha na tela (escala coords do infer_frame para o frame original)
                    scale_x = frame.shape[1] / infer_frame.shape[1]
                    scale_y = frame.shape[0] / infer_frame.shape[0]
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    x1, x2 = int(x1*scale_x), int(x2*scale_x)
                    y1, y2 = int(y1*scale_y), int(y2*scale_y)
                    color = (0, 0, 255) if last_event == "fogo" else (128, 128, 128)
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    cv2.putText(frame, f"{last_event} {current_conf:.2f}", (x1, y1 - 10),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

        # 4. Filtro Temporal (Atividade 2.2) [cite: 43, 44]
        if detected_this_frame:
            consecutive_detections += 1
            clear_frames_since_alert = 0
        else:
            consecutive_detections = 0  # Reseta se houver um frame limpo
            if alert_latched:
                clear_frames_since_alert += 1
                if clear_frames_since_alert >= CLEAR_FRAMES_TO_REARM:
                    alert_latched = False
                    clear_frames_since_alert = 0
                    print("🟢 Cena limpa novamente. Sistema rearmado para um novo alerta.")

        # 5. Geracao de Telemetria de Alerta (Atividade 2.3) [cite: 45, 46]
        if not alert_latched and consecutive_detections >= CONFIRMATION_FRAMES:
            loc = PATROL_PATH[patrol_idx]  # Setor atual do AMR no momento do alerta

            # Estrutura exata do Contrato JSON [cite: 15-20]
            payload = {
                "id_alerta": f"ALRT-{int(time.time()) % 10000}",
                "timestamp": _utc_timestamp(),
                "evento": last_event,
                "confianca": round(current_conf, 2),
                "localizacao_otimizada": loc,
                "llm_prompt": f"Gerar report urgente: {last_event.upper()} detectado no {loc['setor']}."
            }

            try:
                response = requests.post(
                    API_URL,
                    json=payload,
                    headers=REQUEST_HEADERS,
                    timeout=2.0
                )
                emoji = "🔥" if last_event == "fogo" else "💨"
                print(f"{emoji} Alerta enviado [{payload['id_alerta']}] — {last_event} ({payload['confianca']*100:.0f}%) — {loc['setor']} → HTTP {response.status_code}")
            except Exception as e:
                print(f"⚠️  Erro ao enviar alerta: {e}")

            alert_latched = True
            clear_frames_since_alert = 0

            # Reseta o contador apos o envio e mantem o latch ativo para evitar spam
            consecutive_detections = 0
            _publish_stream_frame(frame, paused=True)
            _write_monitoring_state('paused', f'alert:{last_event}')
            last_heartbeat = _pause_until_resumed()
            alert_latched = False
            clear_frames_since_alert = 0
            consecutive_detections = 0

        if now - last_publish_at >= (1 / PUBLISH_MAX_FPS):
            _publish_stream_frame(frame)
            last_publish_at = now

    cap.release()

if __name__ == "__main__":
    start_inference()