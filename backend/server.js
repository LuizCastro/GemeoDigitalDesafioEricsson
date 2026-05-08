// ==========================================
// server.js — Backend Node.js (Express + WebSocket)
// Gêmeo Digital de Segurança (AMR)
// ==========================================
// Recebe POST /alerta do Python (fire_equipe2.py)
// Valida o JSON contra o contrato
// Faz broadcast via WebSocket para o Dashboard React
// ==========================================

require('dotenv').config();
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const { spawn } = require('child_process');

// ── Portas ──
const HTTP_PORT = 3000;
const WS_PORT = 3001;

// ── Express (HTTP API) ──
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ── Middleware de autorização por token fixo ──
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'GEMEO_DIGITAL_5G_ERICSSON_2026_9f3a27c1';
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Não autorizado. Token inválido.' });
  }
  next();
}

// ── WebSocket Server ──

// Variável global para controlar o processo do monitoramento de fogo
let fireProcess = null;
const wsServer = http.createServer();
const wss = new WebSocket.Server({ server: wsServer });

let clientCount = 0;
wss.on('connection', (ws) => {
  clientCount++;
  console.log(`🟢 Cliente conectado (total: ${clientCount})`);

  // Envia estado inicial ao novo cliente
  ws.send(JSON.stringify({
    type: 'connection',
    message: 'Conectado ao Gêmeo Digital',
    clients: clientCount
  }));

  ws.on('close', () => {
    clientCount--;
    console.log(`🔴 Cliente desconectado (total: ${clientCount})`);
  });
});

function broadcast(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ── Validação simples do payload ──
function validatePayload(body) {
  const errors = [];

  if (!body.timestamp) errors.push('Campo "timestamp" obrigatório');
  if (!body.evento) errors.push('Campo "evento" obrigatório');
  if (!['fogo', 'fumaca', 'normal'].includes(body.evento)) {
    errors.push('Campo "evento" deve ser "fogo", "fumaca" ou "normal"');
  }
  if (typeof body.confianca !== 'number' || body.confianca < 0 || body.confianca > 1) {
    errors.push('Campo "confianca" deve ser número entre 0 e 1');
  }
  if (!body.localizacao_otimizada || typeof body.localizacao_otimizada !== 'object') {
    errors.push('Campo "localizacao_otimizada" obrigatório (objeto com x, y, setor)');
  }

  return errors;
}

function generateFallbackLLMReport(payload) {
  const severity = payload.evento === 'fogo' ? 'CRÍTICO' : 'ATENÇÃO';
  const setor = payload.localizacao_otimizada?.setor || 'Desconhecido';
  const conf = (payload.confianca * 100).toFixed(1);

  if (payload.evento === 'normal') {
    return `[RELATÓRIO AUTOMÁTICO] Patrulha de rotina no setor "${setor}". ` +
      `Leituras térmicas normais. Nenhuma anomalia detectada pelo sistema de IA.`;
  }

  return `[${severity}] Princípio de ${payload.evento.toUpperCase()} detectado ` +
    `no setor "${setor}" às ${new Date(payload.timestamp).toLocaleTimeString('pt-BR')}. ` +
    `Confiança da IA: ${conf}%. ` +
    `Recomendação: Acionar protocolo de evacuação e brigada de incêndio imediatamente. ` +
    `Coordenadas do AMR: (${payload.localizacao_otimizada?.x?.toFixed(1)}, ` +
    `${payload.localizacao_otimizada?.y?.toFixed(1)}).`;
}

function buildGroqMessages(payload) {
  const setor = payload.localizacao_otimizada?.setor || 'Desconhecido';
  const confianca = typeof payload.confianca === 'number'
    ? `${(payload.confianca * 100).toFixed(1)}%`
    : 'N/A';

  return [
    {
      role: 'system',
      content: 'Você é um analista industrial de resposta a incidentes. Responda em português do Brasil, em no máximo 4 frases curtas, com foco em: resumo do evento, risco operacional, ação imediata e observação objetiva. Não invente sensores ou dados ausentes.'
    },
    {
      role: 'user',
      content:
        `Gere um relatório operacional para o dashboard com base nesta telemetria:\n` +
        `- Timestamp: ${payload.timestamp}\n` +
        `- Evento: ${payload.evento}\n` +
        `- Confiança: ${confianca}\n` +
        `- Setor: ${setor}\n` +
        `- Coordenadas 2D: x=${payload.localizacao_otimizada?.x ?? 'N/A'}, y=${payload.localizacao_otimizada?.y ?? 'N/A'}\n` +
        `- ID do alerta: ${payload.id_alerta || 'N/A'}\n` +
        `Se o evento for normal, descreva a patrulha sem alarmismo. Se for fogo ou fumaça, priorize contenção e segurança.`
    }
  ];
}

async function generateLLMReport(payload) {
  if (!GROQ_API_KEY) {
    return generateFallbackLLMReport(payload);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 180,
        messages: buildGroqMessages(payload),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error('Resposta da Groq sem conteúdo');
    }

    return content;
  } catch (error) {
    console.warn('Falha ao consultar a Groq, usando fallback local:', error.message);
    return generateFallbackLLMReport(payload);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Histórico de alertas (em memória) ──
const alertHistory = [];
const MAX_HISTORY = 50;

// ── Rotas HTTP ──

// POST /alerta — recebe telemetria do Python (requer autorização)
app.post('/alerta', authMiddleware, async (req, res) => {
  const errors = validatePayload(req.body);

  if (errors.length > 0) {
    console.warn('❌ Payload inválido:', errors);
    return res.status(400).json({ error: 'Payload inválido', details: errors });
  }

  // Enriquece o payload
  const llmReport = await generateLLMReport(req.body);
  const enriched = {
    ...req.body,
    id_alerta: req.body.id_alerta || `ALRT-${Date.now().toString(36).toUpperCase()}`,
    server_timestamp: new Date().toISOString(),
    llm_report: llmReport,
    type: 'alerta'
  };

  // Guarda no histórico
  alertHistory.unshift(enriched);
  if (alertHistory.length > MAX_HISTORY) alertHistory.pop();

  // Broadcast para todos os clientes WebSocket
  broadcast(enriched);

  const emoji = enriched.evento === 'fogo' ? '🔥' : enriched.evento === 'fumaca' ? '💨' : '✅';
  console.log(`${emoji} Alerta [${enriched.id_alerta}] — ${enriched.evento} (${(enriched.confianca * 100).toFixed(1)}%) — ${enriched.localizacao_otimizada?.setor}`);

  res.json({ status: 'ok', id_alerta: enriched.id_alerta });
});

app.post('/api/llm-report', async (req, res) => {
  const errors = validatePayload(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Payload inválido', details: errors });
  }

  try {
    const llm_report = await generateLLMReport(req.body);
    res.json({ llm_report, provider: GROQ_API_KEY ? 'groq' : 'fallback' });
  } catch (error) {
    console.error('Erro ao gerar relatório LLM:', error);
    res.status(500).json({ error: 'Falha ao gerar relatório LLM.' });
  }
});

// GET /alertas — retorna histórico (para debug / UI)
app.get('/alertas', (req, res) => {
  res.json(alertHistory);
});

// GET /health — health check
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    ws_clients: clientCount,
    alertas_total: alertHistory.length,
    uptime: process.uptime()
  });
});

// POST /start-fire-monitoring — Inicia o script de monitoramento
app.post('/start-fire-monitoring', (req, res) => {
  if (fireProcess) {
    return res.status(400).json({ error: 'O monitoramento já está em execução.' });
  }

  fireProcess = spawn('python', ['edge/fire_equipe2.py'], { stdio: 'inherit' });

  fireProcess.on('close', (code) => {
    console.log(`Processo fire_equipe2.py encerrado com código ${code}`);
    fireProcess = null;
  });

  res.json({ status: 'Monitoramento iniciado.' });
});

// POST /stop-fire-monitoring — Para o script de monitoramento
app.post('/stop-fire-monitoring', (req, res) => {
  if (!fireProcess) {
    return res.status(400).json({ error: 'Nenhum monitoramento está em execução.' });
  }

  fireProcess.kill();
  fireProcess = null;

  res.json({ status: 'Monitoramento parado.' });
});

// ── Inicialização ──
app.listen(HTTP_PORT, () => {
  console.log(`\n🔧 ════════════════════════════════════════════`);
  console.log(`   GÊMEO DIGITAL — Backend Online`);
  console.log(`   HTTP API:   http://localhost:${HTTP_PORT}`);
  console.log(`   WebSocket:  ws://localhost:${WS_PORT}`);
  console.log(`   Health:     http://localhost:${HTTP_PORT}/health`);
  console.log(`🔧 ════════════════════════════════════════════\n`);
});

wsServer.listen(WS_PORT, () => {
  console.log(`🔌 WebSocket server pronto na porta ${WS_PORT}`);
});
