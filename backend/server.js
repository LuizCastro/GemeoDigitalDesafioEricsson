// ==========================================
// server.js — Backend Node.js (Express + WebSocket)
// Gêmeo Digital de Segurança (AMR)
// ==========================================
// Recebe POST /alerta do Python (fire_equipe2.py)
// Valida o JSON contra o contrato
// Faz broadcast via WebSocket para o Dashboard React
// ==========================================

const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

// ── Portas ──
const HTTP_PORT = 3000;
const WS_PORT = 3001;

// ── Express (HTTP API) ──
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── WebSocket Server ──
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

// ── Mock LLM Reporter ──
// Substitua esta função pela chamada real à API LLM quando disponível
function generateLLMReport(payload) {
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

// ── Histórico de alertas (em memória) ──
const alertHistory = [];
const MAX_HISTORY = 50;

// ── Rotas HTTP ──

// POST /alerta — recebe telemetria do Python
app.post('/alerta', (req, res) => {
  const errors = validatePayload(req.body);
  
  if (errors.length > 0) {
    console.warn('❌ Payload inválido:', errors);
    return res.status(400).json({ error: 'Payload inválido', details: errors });
  }

  // Enriquece o payload
  const enriched = {
    ...req.body,
    id_alerta: req.body.id_alerta || `ALRT-${Date.now().toString(36).toUpperCase()}`,
    server_timestamp: new Date().toISOString(),
    llm_report: generateLLMReport(req.body),
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
