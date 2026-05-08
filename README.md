# 🏭 Gêmeo Digital de Segurança — AMR Fire Detection

> Hackathon Ericsson | Visão Computacional + Robótica + Gêmeos Digitais

---

## Estrutura do Projeto

```
GEMEODIGITAL/
│
├── edge/                        🔴 CAMADA 1 — Edge / IA (Python)
│   ├── fire_equipe2.py              Inferência YOLO + heartbeat de patrulha
│   ├── download_model.py            Baixa best.pt ou cria fallback
│   ├── smoke-fire-detection-yolo-v12.ipynb   Notebook de treinamento
│   ├── requirements.txt
│   └── models/
│       ├── best.pt                  Modelo treinado Squad 1 (fire/smoke)
│       └── yolov8n_fallback.pt      COCO genérico (fallback para demo)
│
├── backend/                     🟡 CAMADA 2 — Backend (Node.js)
│   ├── server.js                    Express HTTP (3000) + WebSocket (3001)
│   └── test_payload.json            Payload de teste (debug)
│
├── frontend/                    🟢 CAMADA 3 — Frontend (React + Three.js)
│   ├── index.html                   Vite entry point
│   ├── vite.config.js
│   ├── public/
│   │   ├── usina_interno.glb        Modelo 3D da usina
│   │   └── carrinho.svg             Ícone SVG do AMR (reserva)
│   └── src/
│       ├── main.jsx                 Entry point React
│       └── components/
│           ├── DashboardAMR.jsx     Dashboard 3D/VR principal
│           └── DashboardAMR.css     Estilos ISA-101 (dark mode)
│
├── docs/                        📄 Documentação
│   ├── proposta de execução.pdf
│   ├── Desafio-2-*.pdf
│   └── README.md
│
└── package.json                 Scripts npm (dev / server / start)
```

---

## Como Rodar

### Pré-requisitos
- Node.js 18+
- Python 3.10+

### Instalar dependências

```bash
# Node (frontend + backend)
npm install

# Python (edge)
pip install -r edge/requirements.txt
```

### Configurar Groq

Defina as variáveis de ambiente antes de subir o backend:

```bash
# PowerShell
$env:GROQ_API_KEY="sua_chave_groq"
$env:GROQ_MODEL="llama-3.3-70b-versatile"

# bash
export GROQ_API_KEY="sua_chave_groq"
export GROQ_MODEL="llama-3.3-70b-versatile"
```

Sem `GROQ_API_KEY`, o backend mantém um fallback local para não quebrar o dashboard.

### Baixar modelo de IA

```bash
python edge/download_model.py
```

### Iniciar tudo de uma vez

```bash
npm start
# → Backend:  http://localhost:3000
# → WebSocket: ws://localhost:3001
# → Frontend: http://localhost:5173
```

### Ou separado

```bash
npm run server   # Apenas backend
npm run dev      # Apenas frontend
```

### Iniciar inferência Python (requer câmara/vídeo)

```bash
python -m edge.fire_equipe2
```

---

## Fluxo de Dados

```
Câmara → fire_equipe2.py → POST /alerta → server.js → WS broadcast → DashboardAMR.jsx
  (YOLO)     (Edge Python)   (HTTP 3000)  (Node.js)   (ws://3001)     (React + Three.js)
```

### Heartbeat de patrulha
O `fire_equipe2.py` envia um evento `normal` a cada **3 segundos** com a posição
atual do setor, permitindo que o dashboard mostre o robô em movimento mesmo sem incidentes.

---

## Contrato JSON (POST /alerta)

```json
{
  "id_alerta":   "ALRT-1234",
  "timestamp":   "2026-05-06T19:40:00Z",
  "evento":      "fogo | fumaca | normal",
  "confianca":   0.94,
  "localizacao_otimizada": {
    "x":     350,
    "y":     120,
    "setor": "Setor D - Caldeiras Químicas"
  },
  "llm_prompt": "..."
}
```

---

## O que falta por Squad

### 🔴 Squad 1 — Edge / IA
- [ ] Substituir `PATROL_PATH` simulado por telemetria real do AMR (GPS/odometria)
- [ ] Integrar `best.pt` treinado no Kaggle (substituir fallback COCO)
- [ ] Suporte a stream RTSP da câmara do robô (trocar `VideoCapture(0)`)

### 🟡 Squad 2 — Backend
- [x] Integrar `generateLLMReport()` com Groq via backend Node.js
- [ ] Persistência de alertas (SQLite ou arquivo JSON) — atualmente só em memória
- [ ] Autenticação no endpoint POST /alerta (token fixo ou API key)

### 🟢 Squad 3 — Frontend
- [ ] Feed de vídeo real em vez do placeholder CSS animado
- [ ] Painel de histórico de alertas (GET /alertas do backend)
- [ ] Botão "ACIONAR BRIGADA" com ação real (webhook/notificação)


---

## Como Rodar

### Pré-requisitos
- Node.js 18+
- Python 3.10+ (para a camada Edge)

### 1. Instalar dependências
```bash
npm install
```

### 2. Iniciar o sistema completo (Backend + Frontend)
```bash
npm run start
```
Isso inicia:
- **Backend** (Express HTTP): `http://localhost:3000`
- **WebSocket**: `ws://localhost:3001`
- **Frontend** (Vite): `http://localhost:5173`

### 3. (Opcional) Rodar a inferência Python
```bash
cd edge
python fire_equipe2.py
```

---

## Scripts Disponíveis

| Comando | Descrição |
|---------|-----------|
| `npm run start` | Inicia backend + frontend simultaneamente |
| `npm run dev` | Inicia apenas o frontend (Vite) |
| `npm run server` | Inicia apenas o backend (Node.js) |
| `npm run build` | Build de produção do frontend |

---

## Arquitetura

```
📷 Câmera AMR
    ↓ (frames)
🔴 Python (YOLO + Filtro Temporal)
    ↓ HTTP POST /alerta
🟡 Node.js (Validação + LLM + WebSocket)
    ↓ WebSocket broadcast
🟢 React (Dashboard 3D/VR)
    ↓
👷 Operador visualiza no browser
```

O frontend também chama `POST /api/llm-report` no modo demo, para que a análise exibida no painel use o mesmo fluxo da Groq em vez de texto mockado localmente.

---

## Equipe
- **Squad 1** — Treinamento do modelo YOLOv12
- **Squad 2** — Script de inferência (edge/)
- **Squad 3** — Backend + Frontend (backend/ + src/)
- **Squad 4** — Integração LLM
