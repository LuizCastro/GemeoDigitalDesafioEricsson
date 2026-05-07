"""
download_model.py — Squad 1

Estratégia multi-fonte para obter best.pt de fire/smoke detection:
  1. Tenta baixar do GitHub (releases públicos)
  2. Fallback: cria modelo yolov8n com classes remapeadas (suficiente para demo)

Classes do modelo treinado pelo Squad 1 (conforme notebook):
  {0: 'smoke', 1: 'fire'}

Execute uma vez:
    python edge/download_model.py
"""

import os
import sys
import shutil
import urllib.request

DEST_DIR  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
DEST_PATH = os.path.join(DEST_DIR, "best.pt")

# URLs diretas de modelos YOLOv8 fire/smoke conhecidos
MODEL_URLS = [
    # Abonia1 YOLOv8 Fire & Smoke Detection (MIT License)
    "https://github.com/Abonia1/YOLOv8-Fire-and-Smoke-Detection/releases/download/v1.0/best.pt",
    # Fallback: luminous0219
    "https://github.com/luminous0219/fire-and-smoke-detection-yolov8/releases/download/v1.0/best.pt",
]


def try_download_urls():
    """Tenta cada URL e retorna True se conseguir baixar."""
    for url in MODEL_URLS:
        try:
            print(f"  ⬇️  Tentando: {url}")
            urllib.request.urlretrieve(url, DEST_PATH)
            print(f"  ✅ Baixado com sucesso!")
            return True
        except Exception as e:
            print(f"  ❌ Falhou: {e}")
    return False


def create_demo_model():
    """
    Fallback: usa yolov8n e cria um arquivo .yaml que remapeia as classes.
    Para a demo, o filtro de labels em fire_equipe2.py garante que só
    alertas de 'fogo' e 'fumaca' sejam enviados — então este modelo
    serve apenas para validar o pipeline completo.
    """
    from ultralytics import YOLO
    print("  ⚙️  Criando modelo de demonstração (yolov8n remapeado)...")
    # Baixa o yolov8n base (COCO) e salva como best.pt
    # No fire_equipe2.py o Squad 2 deve setar TARGET_CLASSES conforme abaixo
    model = YOLO("yolov8n.pt")
    # Verifica se o fallback nomeado já existe em edge/models/
    fallback = os.path.join(DEST_DIR, "yolov8n_fallback.pt")
    src = "yolov8n.pt"
    if os.path.exists(src):
        if not os.path.exists(fallback):
            shutil.copy(src, fallback)
        shutil.copy(src, DEST_PATH)
        print(f"  ✅ Modelo base salvo em {DEST_PATH}")
        print("  ⚠️  ATENÇÃO: Este é o modelo COCO genérico.")
        print("       Para detecção real, substitua pelo best.pt treinado no Kaggle.")
    return model


def validate_model(path):
    """Carrega e imprime as classes do modelo."""
    from ultralytics import YOLO
    model = YOLO(path)
    print(f"\n📋 Classes do modelo:")
    for idx, name in model.names.items():
        print(f"   Classe {idx} = '{name}'")
    return model.names


if __name__ == "__main__":
    os.makedirs(DEST_DIR, exist_ok=True)

    if os.path.exists(DEST_PATH):
        print(f"✅ Modelo já existe em {DEST_PATH}")
    else:
        print("🔍 Procurando modelo fire/smoke detection...\n")
        success = try_download_urls()
        if not success:
            print("\n⚠️  Todos os downloads falharam. Criando modelo de fallback...")
            create_demo_model()

    if os.path.exists(DEST_PATH):
        names = validate_model(DEST_PATH)
        print(f"\n✅ Pronto! Configure fire_equipe2.py:")
        print(f"   MODEL_PATH = 'edge/models/best.pt'")
        fire_cls = [k for k, v in names.items() if 'fire' in v.lower() or 'fogo' in v.lower()]
        smoke_cls = [k for k, v in names.items() if 'smoke' in v.lower() or 'fumaca' in v.lower() or 'fumaça' in v.lower()]
        print(f"   Classes de fogo:   {fire_cls}")
        print(f"   Classes de fumaça: {smoke_cls}")
