import React, { useState, useEffect, Suspense, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF, Html, Grid } from '@react-three/drei';
import { XR, createXRStore } from '@react-three/xr';
import * as THREE from 'three';
import './DashboardAMR.css';

// ==========================================
// XR STORE — criado fora do componente para persistência
// ==========================================
const xrStore = createXRStore();

// ==========================================
// 1. DADOS ESTÁTICOS E CONFIGURAÇÕES
// ==========================================
const FACTORY_ZONES = [
  { id: 'zone-a', name: 'Setor A - Turbinas', x: 50, y: 50, width: 200, height: 150 },
  { id: 'zone-b', name: 'Setor B - Geradores', x: 260, y: 50, width: 200, height: 150 },
  { id: 'zone-c', name: 'Setor C - Painéis de Controlo', x: 50, y: 210, width: 200, height: 150 },
  { id: 'zone-d', name: 'Setor D - Caldeiras Químicas', x: 260, y: 210, width: 200, height: 150 },
];

const ROBOT_PATH = [
  { x: 150, y: 125, x3d: -4,   y3d: 0.5, z3d: -3,  zone: 'Setor A - Turbinas' },
  { x: 360, y: 125, x3d:  4,   y3d: 0.5, z3d: -3,  zone: 'Setor B - Geradores' },
  { x: 360, y: 285, x3d:  4,   y3d: 0.5, z3d:  3,  zone: 'Setor D - Caldeiras Químicas' },
  { x: 150, y: 285, x3d: -4,   y3d: 0.5, z3d:  3,  zone: 'Setor C - Painéis de Controlo' },
];

// ==========================================
// MODELO MATEMÁTICO — Localização por Projeção Lagrangiana
//
// Dado um ponto estimado (ex: centro do setor vindo da LLM),
// encontramos a posição mais provável NA ROTA de patrulha
// resolvendo a restrição de caminho via mínimos de Lagrange:
//
//   argmin  ||p - p_target||²
//   s.t.    p ∈ segmento W_k → W_{k+1}
//
// Solução fechada: projeção ortogonal do ponto no segmento.
// t* = clamp( (p_target - W_k) · (W_{k+1} - W_k) / |W_{k+1}-W_k|² , 0, 1 )
// p* = W_k + t* * (W_{k+1} - W_k)
//
// A "confiança de posição" mede se o ponto LLM é consistente
// com a posição física estimada:
//   conf_pos = exp(-β * ||p* - C_setor||²)
//   < 0.6  → contradição entre LLM e posição física
// ==========================================

/** Vértices do caminho de patrulha em coordenadas 3D */
const PATH_WAYPOINTS = ROBOT_PATH.map(p => new THREE.Vector3(p.x3d, p.y3d, p.z3d));

/**
 * Projeta um ponto no segmento de caminho mais próximo (Lagrange path constraint).
 * Retorna { point: Vector3, segmentIndex: number, t: number }
 */
function projectOntoPatrolPath(point) {
  let bestDist = Infinity;
  let bestPoint = PATH_WAYPOINTS[0].clone();
  let bestSeg = 0;
  let bestT = 0;

  for (let k = 0; k < PATH_WAYPOINTS.length; k++) {
    const Wk  = PATH_WAYPOINTS[k];
    const Wk1 = PATH_WAYPOINTS[(k + 1) % PATH_WAYPOINTS.length];
    const dir = new THREE.Vector3().subVectors(Wk1, Wk);
    const len2 = dir.lengthSq();

    // t* = clamp( (p - Wk) · dir / |dir|² , 0, 1 )
    const t = Math.max(0, Math.min(1,
      new THREE.Vector3().subVectors(point, Wk).dot(dir) / len2
    ));
    const projected = Wk.clone().addScaledVector(dir, t);
    const dist = point.distanceTo(projected);

    if (dist < bestDist) {
      bestDist  = dist;
      bestPoint = projected;
      bestSeg   = k;
      bestT     = t;
    }
  }
  return { point: bestPoint, segmentIndex: bestSeg, t: bestT, distFromPath: bestDist };
}

/**
 * Verifica se a localização declarada pela LLM é consistente com a posição 3D
 * usando a função de confiança: conf = exp(-β * ||p_path - C_setor||²)
 * Retorna valor 0..1 (1 = totalmente consistente)
 */
const SECTOR_CENTERS_3D = {
  'Setor A - Turbinas':            new THREE.Vector3(-4, 0.5, -3),
  'Setor B - Geradores':           new THREE.Vector3( 4, 0.5, -3),
  'Setor C - Painéis de Controlo': new THREE.Vector3(-4, 0.5,  3),
  'Setor D - Caldeiras Químicas':  new THREE.Vector3( 4, 0.5,  3),
};
const BETA = 0.18; // controla a largura da gaussiana de confiança

function computeLocationConsistency(projectedPos, declaredSector) {
  const center = SECTOR_CENTERS_3D[declaredSector];
  if (!center) return null;
  const dist2 = projectedPos.distanceToSquared(center);
  return Math.exp(-BETA * dist2);
}

// Pré-carrega o GLB para evitar flash ao montar o componente
useGLTF.preload('/usina_interno.glb');

// ==========================================
// 2. SUBCOMPONENTES 3D
// ==========================================

function UsinaModel() {
  const { scene } = useGLTF('/usina_interno.glb');
  return <primitive object={scene} dispose={null} />;
}

function RobotAMR({ x, y, z, isAlert, onPositionUpdate }) {
  const robotColor  = isAlert ? '#ef4444' : '#60a5fa';
  const glowColor   = isAlert ? '#ff0000' : '#3b82f6';
  const groupRef    = React.useRef();
  const bodyRef     = React.useRef();

  // ─── Posição atual interpolada (movimento suave) ───────────────────────────
  // currentPos é a posição "física" que se move gradualmente em direção ao alvo.
  // O lerp por frame é equivalente a um passo de gradient descent:
  //   p(t+dt) = p(t) + speed*dt * (target - p(t)) / |target - p(t)|
  // com step adaptativo que satura em speed*dt para evitar overshoot.
  const currentPos = React.useRef(new THREE.Vector3(x, y, z));
  const targetPos  = React.useRef(new THREE.Vector3(x, y, z));

  // Atualiza o alvo quando as props mudam (novo setor vindo do WS/mock)
  React.useEffect(() => {
    targetPos.current.set(x, y, z);
  }, [x, y, z]);

  useFrame((state, delta) => {
    if (!groupRef.current) return;

    // Velocidade: 2 m/s em escala de cena (~velocidade real de AMR industrial)
    const SPEED = 2.0;
    const distToTarget = currentPos.current.distanceTo(targetPos.current);

    if (distToTarget > 0.01) {
      // Passo máximo neste frame para não ultrapassar o alvo
      const step = Math.min(SPEED * delta, distToTarget);
      currentPos.current.lerp(targetPos.current, step / distToTarget);
    }

    // Aplica posição ao grupo 3D
    groupRef.current.position.copy(currentPos.current);

    // Rotação: aponta o visor (eixo +Z local) para a direção de movimento
    const dir = new THREE.Vector3().subVectors(targetPos.current, currentPos.current);
    if (dir.lengthSq() > 0.0001) {
      const angle = Math.atan2(dir.x, dir.z);
      groupRef.current.rotation.y = THREE.MathUtils.lerp(
        groupRef.current.rotation.y, angle, 8 * delta
      );
    }

    // Projeta posição atual no caminho (Lagrange path constraint)
    // e reporta a consistência com o setor declarado
    if (onPositionUpdate) {
      const projected = projectOntoPatrolPath(currentPos.current);
      onPositionUpdate(currentPos.current.clone(), projected);
    }

    // Pulsação no alerta
    if (bodyRef.current) {
      const t = state.clock.getElapsedTime();
      bodyRef.current.material.emissiveIntensity = isAlert
        ? 0.4 + Math.sin(t * 6) * 0.3
        : 0.15;
    }
  });

  // Rotação das rodas proporcional à velocidade
  const wheelRefs = [useRef(), useRef(), useRef(), useRef()];
  useFrame((_, delta) => {
    const moving = currentPos.current.distanceTo(targetPos.current) > 0.05;
    wheelRefs.forEach(r => {
      if (r.current && moving) r.current.rotation.x += delta * 4;
    });
  });

  return (
    <group ref={groupRef} scale={1.4}>

      {/* Luz pontual forte em volta do robo */}
      <pointLight color={glowColor} intensity={isAlert ? 12 : 5} distance={8} decay={2} />

      {/* === CORPO PRINCIPAL (chassis) === */}
      <mesh ref={bodyRef} position={[0, 0.25, 0]} castShadow>
        <boxGeometry args={[0.9, 0.4, 1.2]} />
        <meshStandardMaterial
          color={robotColor}
          emissive={glowColor}
          emissiveIntensity={0.15}
          roughness={0.3}
          metalness={0.7}
        />
      </mesh>

      {/* === CABINE (topo) === */}
      <mesh position={[0, 0.58, -0.1]} castShadow>
        <boxGeometry args={[0.6, 0.28, 0.6]} />
        <meshStandardMaterial color={isAlert ? '#7f1d1d' : '#1e3a5f'} roughness={0.4} metalness={0.6} />
      </mesh>

      {/* === VISOR (frente da cabine) === */}
      <mesh position={[0, 0.58, 0.2]} castShadow>
        <boxGeometry args={[0.55, 0.18, 0.05]} />
        <meshStandardMaterial
          color={isAlert ? '#ff6666' : '#7dd3fc'}
          emissive={isAlert ? '#ff0000' : '#60a5fa'}
          emissiveIntensity={0.8}
          roughness={0.1}
          metalness={0.1}
        />
      </mesh>

      {/* === RODAS (4x) com rotação animada === */}
      {[[-0.48, -0.12, 0.38], [0.48, -0.12, 0.38], [-0.48, -0.12, -0.38], [0.48, -0.12, -0.38]].map(
        ([wx, wy, wz], i) => (
          <mesh key={i} ref={wheelRefs[i]} position={[wx, wy, wz]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.2, 0.2, 0.15, 12]} />
            <meshStandardMaterial color="#1e293b" roughness={0.9} metalness={0.3} />
          </mesh>
        )
      )}

      {/* === SENSOR LIDAR (topo) === */}
      <mesh position={[0, 0.78, -0.1]} castShadow>
        <cylinderGeometry args={[0.12, 0.12, 0.12, 16]} />
        <meshStandardMaterial
          color="#f8fafc"
          emissive={isAlert ? '#ff4444' : '#60a5fa'}
          emissiveIntensity={0.6}
          roughness={0.2}
          metalness={0.8}
        />
      </mesh>

      {/* === ANTENA === */}
      <mesh position={[0.28, 0.95, -0.1]}>
        <cylinderGeometry args={[0.015, 0.015, 0.5, 6]} />
        <meshStandardMaterial color="#94a3b8" metalness={0.9} roughness={0.1} />
      </mesh>
      <mesh position={[0.28, 1.22, -0.1]}>
        <sphereGeometry args={[0.04, 8, 8]} />
        <meshStandardMaterial color={robotColor} emissive={glowColor} emissiveIntensity={1.5} />
      </mesh>

      {/* === TAG FLUTUANTE === */}
      <Html center distanceFactor={10} style={{ pointerEvents: 'none' }} position={[0, 1.6, 0]}>
        <div style={{
          background: 'rgba(2, 6, 23, 0.92)',
          border: `2px solid ${robotColor}`,
          color: robotColor,
          padding: '4px 12px',
          borderRadius: '4px',
          fontSize: '11px',
          fontFamily: 'JetBrains Mono, monospace',
          fontWeight: 'bold',
          whiteSpace: 'nowrap',
          textShadow: `0 0 10px ${robotColor}`,
          boxShadow: `0 0 12px ${robotColor}66, inset 0 0 8px ${robotColor}22`,
          letterSpacing: '0.05em',
        }}>
          {isAlert ? '🔥 AMR-01 • ALERTA' : '● AMR-01'}
        </div>
      </Html>

    </group>
  );
}

// Fallback enquanto o GLB carrega
function SceneFallback() {
  return (
    <mesh>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#334155" wireframe />
    </mesh>
  );
}

// ==========================================
// 3. MAPEAMENTO SETOR → COORDENADA 3D
// Traduz o nome do setor (vindo do Python) para posição na cena Three.js
// ==========================================
const SECTOR_TO_3D = {
  'Setor A - Turbinas':            { x3d: -4, y3d: 0.5, z3d: -3 },
  'Setor B - Geradores':           { x3d:  4, y3d: 0.5, z3d: -3 },
  'Setor C - Painéis de Controlo': { x3d: -4, y3d: 0.5, z3d:  3 },
  'Setor D - Caldeiras Químicas':  { x3d:  4, y3d: 0.5, z3d:  3 },
};
const DEFAULT_3D = { x3d: 0, y3d: 0.5, z3d: 0 };

// ==========================================
// 4. COMPONENTE PRINCIPAL
// ==========================================
export default function DigitalTwinDashboard() {
  const [systemState, setSystemState] = useState('NORMAL');
  const [is3DMode, setIs3DMode] = useState(true);
  const [dataSource, setDataSource] = useState('mock'); // 'mock' | 'live'
  // Consistência entre posição física do robô e localização declarada pela LLM
  // 0..1 onde 1 = totalmente consistente, < 0.6 = contradição
  const [locationConsistency, setLocationConsistency] = useState(null);
  const [telemetry, setTelemetry] = useState({
    id_alerta: 'N/A',
    timestamp: new Date().toISOString(),
    evento: 'normal',
    confianca: 0.0,
    localizacao_otimizada: ROBOT_PATH[0],
    llm_prompt: 'Sistema em patrulha. Operação normal.'
  });

  // ── WebSocket: tenta conectar ao server.js ──
  useEffect(() => {
    let ws;
    let reconnectTimer;

    function connect() {
      try {
        ws = new WebSocket('ws://localhost:3001');

        ws.onopen = () => {
          console.log('🟢 WebSocket conectado ao server.js');
          setDataSource('live');
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'connection') return; // mensagem de boas-vindas

            // Mapeia setor → coordenadas 3D
            const setor = data.localizacao_otimizada?.setor || '';
            const pos3d = SECTOR_TO_3D[setor] || DEFAULT_3D;

            setTelemetry({
              id_alerta: data.id_alerta || 'N/A',
              timestamp: data.timestamp,
              evento: data.evento,
              confianca: data.confianca,
              localizacao_otimizada: {
                ...data.localizacao_otimizada,
                zone: setor,
                ...pos3d,
              },
              llm_prompt: data.llm_report || data.llm_prompt || ''
            });
            setSystemState(data.evento !== 'normal' ? 'ALERT' : 'NORMAL');
          } catch (e) {
            console.warn('Erro ao parsear mensagem WS:', e);
          }
        };

        ws.onclose = () => {
          console.log('🔴 WebSocket desconectado — fallback para mock');
          setDataSource('mock');
          reconnectTimer = setTimeout(connect, 5000);
        };

        ws.onerror = () => {
          ws.close();
        };
      } catch (e) {
        setDataSource('mock');
        reconnectTimer = setTimeout(connect, 5000);
      }
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);

  // ── Mock fallback: só roda se não houver WebSocket ──
  useEffect(() => {
    if (dataSource !== 'mock') return;

    let pathIndex = 0;
    const telemetryInterval = setInterval(() => {
      pathIndex = (pathIndex + 1) % ROBOT_PATH.length;
      const currentPos = ROBOT_PATH[pathIndex];

      const isFire = currentPos.zone === 'Setor D - Caldeiras Químicas';
      const newEvent = isFire ? 'fogo' : 'normal';
      const newConfianca = isFire ? 0.96 : 0.0;

      setTelemetry({
        id_alerta: isFire ? `ALRT-${Math.floor(Math.random() * 1000)}` : 'N/A',
        timestamp: new Date().toISOString(),
        evento: newEvent,
        confianca: newConfianca,
        localizacao_otimizada: currentPos,
        llm_prompt: isFire
          ? `[URGENTE] Princípio de ${newEvent.toUpperCase()} detetado na usina térmica (${currentPos.zone}). Confiança da IA: ${(newConfianca * 100).toFixed(0)}%. Protocolo de evacuação recomendado.`
          : `Patrulha de rotina no ${currentPos.zone}. Leituras térmicas normais.`
      });
      setSystemState(isFire ? 'ALERT' : 'NORMAL');
    }, 4000);

    return () => clearInterval(telemetryInterval);
  }, [dataSource]);

  const isAlert = systemState === 'ALERT';
  const { x3d, y3d, z3d } = telemetry.localizacao_otimizada;

  return (
    <div className="dashboard-container">

      {/* CABEÇALHO */}
      <header className={`dashboard-header ${isAlert ? 'alert' : ''}`}>
        <div>
          <h1 className="header-title">GÊMEO DIGITAL <span>| COMMAND CENTER</span></h1>
          <p className="header-subtitle">
            Suporte Imersivo a Gêmeo Digital (Fallback Seguro)
            <span style={{
              marginLeft: '12px',
              padding: '2px 8px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 'bold',
              fontFamily: 'JetBrains Mono, monospace',
              background: dataSource === 'live' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(251, 191, 36, 0.2)',
              color: dataSource === 'live' ? '#34d399' : '#fbbf24',
              border: `1px solid ${dataSource === 'live' ? '#34d399' : '#fbbf24'}`,
            }}>
              {dataSource === 'live' ? '● LIVE' : '● DEMO'}
            </span>
          </p>
        </div>

        <div className="header-controls">
          {/* Toggle órbita livre / câmara fixa */}
          <button
            onClick={() => setIs3DMode(!is3DMode)}
            className={`btn-3d ${is3DMode ? 'active' : ''}`}
          >
            {is3DMode ? 'ÓRBITA LIVRE' : 'CÂMARA FIXA'}
          </button>

          {/* Botão de entrada em VR */}
          <button
            onClick={() => xrStore.enterVR()}
            className="btn-3d"
            style={{ borderColor: '#a855f7', background: '#3b0764', color: '#d8b4fe' }}
          >
            🥽 ENTRAR VR
          </button>

          <div className="status-block">
            <p className="status-label">Estado do Sistema</p>
            <p className={`status-value font-mono ${isAlert ? 'alert' : ''}`}>
              {isAlert ? 'INCIDENTE CRÍTICO' : 'OPERAÇÃO NORMAL'}
            </p>
          </div>
        </div>
      </header>

      {/* GRID PRINCIPAL */}
      <div className="dashboard-grid">

        {/* COLUNA ESQUERDA: GÊMEO DIGITAL 3D/VR */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="panel" style={{ flex: 1, position: 'relative', height: '600px', padding: 0, overflow: 'hidden' }}>

            {/* Badge de estado da cena */}
            <div className="font-mono" style={{ position: 'absolute', top: '1rem', left: '1rem', zIndex: 10, background: 'rgba(15, 23, 42, 0.88)', padding: '0.5rem 1rem', borderRadius: '0.25rem', fontSize: '0.75rem', color: '#cbd5e1', border: '1px solid #334155' }}>
              <span style={{ color: '#60a5fa' }}>● GÊMEO DIGITAL 3D/VR:</span> usina_interno.glb
            </div>

            {/* ============================================
                CANVAS THREE.JS — substitui o SVG anterior
                ============================================ */}
            <Canvas
              style={{ width: '100%', height: '100%', background: '#080f1e' }}
              camera={{ position: [12, 8, 12], fov: 50, near: 0.1, far: 200 }}
              gl={{ antialias: true }}
              shadows
              onCreated={({ gl }) => gl.setClearColor('#080f1e')}
            >
              {/* Envolve toda a cena com suporte XR/VR */}
              <XR store={xrStore}>

                {/* Iluminacao melhorada */}
                <ambientLight intensity={1.2} />
                <directionalLight
                  position={[15, 20, 10]}
                  intensity={2.0}
                  castShadow
                  shadow-mapSize={[2048, 2048]}
                />
                <directionalLight position={[-10, 10, -10]} intensity={0.8} color="#94b4e0" />
                <pointLight position={[0, 8, 0]} intensity={1.2} color="#f0f4ff" />

                {/* Modelo 3D da Usina carregado do ficheiro GLB */}
                <Suspense fallback={<SceneFallback />}>
                  <UsinaModel />
                </Suspense>

                {/* Plano de chao com grid tático */}
                <Grid
                  position={[0, -0.02, 0]}
                  args={[40, 40]}
                  cellSize={1}
                  cellThickness={0.5}
                  cellColor='#1e3a5f'
                  sectionSize={4}
                  sectionThickness={1}
                  sectionColor='#2563eb'
                  fadeDistance={40}
                  fadeStrength={1}
                  followCamera={false}
                  infiniteGrid
                />

                {/* Robô AMR com posição 3D em tempo real + verificação Lagrangiana */}
                <RobotAMR
                  x={x3d} y={y3d} z={z3d}
                  isAlert={isAlert}
                  onPositionUpdate={(physPos, projected) => {
                    const c = computeLocationConsistency(
                      projected.point,
                      telemetry.localizacao_otimizada.zone
                    );
                    setLocationConsistency(c);
                  }}
                />

                {/* Controlos de órbita — o operador pode girar/zoom com o rato */}
                <OrbitControls
                  enabled={is3DMode}
                  enablePan
                  enableZoom
                  minDistance={3}
                  maxDistance={40}
                  target={[x3d, 0, z3d]}
                  minPolarAngle={Math.PI / 8}
                  maxPolarAngle={Math.PI / 2.2}
                />

              </XR>
            </Canvas>

            {/* Barra de estado inferior */}
            <div className="font-mono" style={{ position: 'absolute', bottom: '1rem', left: '1rem', right: '1rem', background: 'rgba(2, 6, 23, 0.9)', padding: '0.75rem', borderRadius: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid #334155', width: '80%', zIndex: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ color: '#94a3b8' }}>📍 SETOR:</span>
                <strong style={{ color: isAlert ? '#f87171' : 'white' }}>{telemetry.localizacao_otimizada.zone}</strong>
              </div>
              {/* Indicador de consistência LLM ↔ posição física */}
              {locationConsistency !== null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: '#94a3b8', fontSize: '0.7rem' }}>CONF. POS:</span>
                  <span style={{
                    fontSize: '0.75rem',
                    fontWeight: 'bold',
                    color: locationConsistency >= 0.6 ? '#34d399' : '#f87171',
                  }}>
                    {locationConsistency >= 0.6 ? '✓' : '⚠'} {(locationConsistency * 100).toFixed(0)}%
                  </span>
                </div>
              )}
              <div style={{ color: '#475569', fontSize: '0.7rem' }}>
                3D [{x3d.toFixed(1)}, {y3d.toFixed(1)}, {z3d.toFixed(1)}]
              </div>
            </div>
          </div>
        </div>

        {/* COLUNA DIREITA: VÍDEO E IA */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Câmara do Robô (YOLOv12)</h2>
              <span
                className={isAlert ? 'animate-pulse' : ''}
                style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '4px', fontWeight: 'bold', background: isAlert ? '#ef4444' : 'rgba(16, 185, 129, 0.2)', color: isAlert ? 'white' : '#34d399' }}
              >
                {isAlert ? 'FOGO CONFIRMADO' : 'LIMPO'}
              </span>
            </div>

            <div className="video-frame">
              {isAlert ? (
                <>
                  <div className="video-bg alert"></div>
                  <div className="bounding-box">
                    <span className="bb-label font-mono">FOGO {(telemetry.confianca * 100).toFixed(1)}%</span>
                  </div>
                </>
              ) : (
                <div className="video-bg normal"></div>
              )}
              <div className="font-mono" style={{ position: 'absolute', top: '8px', right: '8px', fontSize: '10px', color: 'rgba(255,255,255,0.8)', display: 'flex', gap: '8px', alignItems: 'center', background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: '4px' }}>
                <span className="animate-pulse" style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }}></span>
                REC • 30FPS
              </div>
            </div>
          </div>

          <div className={`panel ${isAlert ? 'alert' : ''}`} style={{ flex: 1 }}>
            <h2 className="panel-title" style={{ borderBottom: '1px solid #334155', paddingBottom: '0.5rem', marginBottom: '0.5rem' }}>Assistente IA</h2>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', alignItems: 'flex-start' }}>
              <div style={{ padding: '0.75rem', borderRadius: '50%', background: isAlert ? 'rgba(127, 29, 29, 0.5)' : '#334155', color: isAlert ? '#f87171' : '#cbd5e1', flexShrink: 0 }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a8 8 0 0 0-8 8c0 5.4 3.6 8.5 6 10.5.4.3.8.7 1.2 1.1a1.5 1.5 0 0 0 1.6 0c.4-.4.8-.8 1.2-1.1 2.4-2 6-5.1 6-10.5a8 8 0 0 0-8-8z" />
                  <path d="M12 14a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
                </svg>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <p className="font-mono" style={{ fontSize: '0.875rem', lineHeight: '1.5', color: isAlert ? '#fca5a5' : '#cbd5e1', fontWeight: isAlert ? 'bold' : 'normal', margin: 0 }}>
                  {telemetry.llm_prompt}
                </p>
                <div style={{ marginTop: '1.5rem' }}>
                  {isAlert && (
                    <button className="btn-action">
                      ACIONAR BRIGADA
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
