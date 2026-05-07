import React, { useState, useEffect, Suspense, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF, Html, Grid } from '@react-three/drei';
import * as THREE from 'three';
import './DashboardAMR.css';

const API_BASE_URL = '/api';
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}/ws/`;

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
  { x: 150, y: 125, x3d: -4, y3d: 0.5, z3d: -3, zone: 'Setor A - Turbinas' },
  { x: 360, y: 125, x3d: 4, y3d: 0.5, z3d: -3, zone: 'Setor B - Geradores' },
  { x: 360, y: 285, x3d: 4, y3d: 0.5, z3d: 3, zone: 'Setor D - Caldeiras Químicas' },
  { x: 150, y: 285, x3d: -4, y3d: 0.5, z3d: 3, zone: 'Setor C - Painéis de Controlo' },
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
    const Wk = PATH_WAYPOINTS[k];
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
      bestDist = dist;
      bestPoint = projected;
      bestSeg = k;
      bestT = t;
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
  'Setor A - Turbinas': new THREE.Vector3(-4, 0.5, -3),
  'Setor B - Geradores': new THREE.Vector3(4, 0.5, -3),
  'Setor C - Painéis de Controlo': new THREE.Vector3(-4, 0.5, 3),
  'Setor D - Caldeiras Químicas': new THREE.Vector3(4, 0.5, 3),
};
const BETA = 0.18; // controla a largura da gaussiana de confiança

function computeLocationConsistency(projectedPos, declaredSector) {
  const center = SECTOR_CENTERS_3D[declaredSector];
  if (!center) return null;
  const dist2 = projectedPos.distanceToSquared(center);
  return Math.exp(-BETA * dist2);
}

// ==========================================
// 2. SUBCOMPONENTES 3D
// ==========================================

function UsinaModel() {
  const { scene } = useGLTF('/usina_interno.glb');
  return <primitive object={scene} dispose={null} />;
}

function RobotAMR({ x, y, z, isAlert, isStopped, onPositionUpdate }) {
  const robotColor = isAlert ? '#ef4444' : '#60a5fa';
  const glowColor = isAlert ? '#ff0000' : '#3b82f6';
  const groupRef = React.useRef();
  const bodyRef = React.useRef();

  // ─── Posição atual interpolada (movimento suave) ───────────────────────────
  // currentPos é a posição "física" que se move gradualmente em direção ao alvo.
  // O lerp por frame é equivalente a um passo de gradient descent:
  //   p(t+dt) = p(t) + speed*dt * (target - p(t)) / |target - p(t)|
  // com step adaptativo que satura em speed*dt para evitar overshoot.
  const currentPos = React.useRef(new THREE.Vector3(x, y, z));
  const targetPos = React.useRef(new THREE.Vector3(x, y, z));

  // Atualiza o alvo quando as props mudam (novo setor vindo do WS/mock)
  React.useEffect(() => {
    if (isStopped) return;
    targetPos.current.set(x, y, z);
  }, [x, y, z, isStopped]);

  useFrame((state, delta) => {
    if (!groupRef.current) return;

    // Velocidade: 2 m/s em escala de cena (~velocidade real de AMR industrial)
    const SPEED = 2.0;
    const distToTarget = currentPos.current.distanceTo(targetPos.current);

    if (!isStopped && distToTarget > 0.01) {
      // Passo máximo neste frame para não ultrapassar o alvo
      const step = Math.min(SPEED * delta, distToTarget);
      currentPos.current.lerp(targetPos.current, step / distToTarget);
    }

    // Aplica posição ao grupo 3D
    groupRef.current.position.copy(currentPos.current);

    // Rotação: aponta o visor (eixo +Z local) para a direção de movimento
    const dir = new THREE.Vector3().subVectors(targetPos.current, currentPos.current);
    if (!isStopped && dir.lengthSq() > 0.0001) {
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
    const moving = !isStopped && currentPos.current.distanceTo(targetPos.current) > 0.05;
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
  'Setor A - Turbinas': { x3d: -4, y3d: 0.5, z3d: -3 },
  'Setor B - Geradores': { x3d: 4, y3d: 0.5, z3d: -3 },
  'Setor C - Painéis de Controlo': { x3d: -4, y3d: 0.5, z3d: 3 },
  'Setor D - Caldeiras Químicas': { x3d: 4, y3d: 0.5, z3d: 3 },
};
const DEFAULT_3D = { x3d: 0, y3d: 0.5, z3d: 0 };

// ==========================================
// 4. COMPONENTE PRINCIPAL
// ==========================================
export default function DigitalTwinDashboard() {
  const [systemState, setSystemState] = useState('NORMAL');
  const [isRobotStopped, setIsRobotStopped] = useState(false);
  const [stoppedLocation, setStoppedLocation] = useState(null);
  const [is3DMode, setIs3DMode] = useState(true);
  const [dataSource, setDataSource] = useState('mock'); // 'mock' | 'live'
  const liveTelemetryTimerRef = useRef(null);
  const currentRobotPositionRef = useRef(null);
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

    const scheduleLiveTimeout = () => {
      clearTimeout(liveTelemetryTimerRef.current);
      liveTelemetryTimerRef.current = setTimeout(() => {
        setDataSource('mock');
      }, 7000);
    };

    function connect() {
      try {
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
          console.log('🟢 WebSocket conectado ao server.js');
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'connection') return; // mensagem de boas-vindas

            setDataSource('live');
            scheduleLiveTimeout();

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
            // Só entra em ALERT e para o robô se não estiver em modo patrulha
            if (data.evento !== 'normal' && !isRobotStopped) {
              setSystemState('ALERT');
              setIsRobotStopped(true);
              if (currentRobotPositionRef.current) {
                setStoppedLocation({
                  ...data.localizacao_otimizada,
                  zone: setor,
                  x3d: currentRobotPositionRef.current.x,
                  y3d: currentRobotPositionRef.current.y,
                  z3d: currentRobotPositionRef.current.z,
                });
              }
            } else if (data.evento === 'normal') {
              setSystemState('NORMAL');
            }
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
      clearTimeout(liveTelemetryTimerRef.current);
      if (ws) ws.close();
    };
  }, [isRobotStopped]);

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
  const statusLabel = isRobotStopped ? 'PARADO' : isAlert ? 'ALERTA' : 'NORMAL';
  // Quando parado, congelar posição do robô em stoppedLocation
  const displayedLocation = isRobotStopped && stoppedLocation
    ? stoppedLocation
    : telemetry.localizacao_otimizada;
  const { x3d, y3d, z3d } = displayedLocation;

  const startPatrol = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/start-fire-monitoring`, {
        method: 'POST',
      });
      if (response.ok) {
        setIsRobotStopped(false);
        setStoppedLocation(null);
        setSystemState('NORMAL'); // Garante que o robô volta a circular
        alert('Patrulha iniciada com sucesso!');
      } else {
        alert('Erro ao iniciar a patrulha.');
      }
    } catch (error) {
      console.error('Erro ao conectar com o backend:', error);
      alert('Erro ao conectar com o backend.');
    }
  };

  const stopPatrol = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/stop-fire-monitoring`, {
        method: 'POST',
      });
      if (response.ok) {
        setIsRobotStopped(true);
        setStoppedLocation(currentRobotPositionRef.current ? {
          ...telemetry.localizacao_otimizada,
          x3d: currentRobotPositionRef.current.x,
          y3d: currentRobotPositionRef.current.y,
          z3d: currentRobotPositionRef.current.z,
        } : telemetry.localizacao_otimizada);
        alert('Patrulha parada com sucesso!');
      } else {
        const err = await response.json().catch(() => ({}));
        alert('Erro ao parar a patrulha.' + (err.error ? `\n${err.error}` : ''));
      }
    } catch (error) {
      console.error('Erro ao conectar com o backend:', error);
      alert('Erro ao conectar com o backend.');
    }
  };

  const handleAlert = () => {
    setIsRobotStopped(true);
    setStoppedLocation(currentRobotPositionRef.current ? {
      ...telemetry.localizacao_otimizada,
      x3d: currentRobotPositionRef.current.x,
      y3d: currentRobotPositionRef.current.y,
      z3d: currentRobotPositionRef.current.z,
    } : telemetry.localizacao_otimizada);
    alert('Alerta recebido! Robô parado no local.');
  };


  useEffect(() => {
    if (systemState === 'ALERT') {
      const audio = new Audio('/alert-sound.mp3');
      audio.play();
    }
  }, [systemState]);

  const handlePositionUpdate = (currentPosition, projected) => {
    // Só atualiza a referência se o robô não estiver parado
    if (!isRobotStopped) {
      currentRobotPositionRef.current = {
        x: currentPosition.x,
        y: currentPosition.y,
        z: currentPosition.z,
      };
    }

    const declaredSector = telemetry.localizacao_otimizada?.zone || telemetry.localizacao_otimizada?.setor;
    if (!declaredSector) {
      setLocationConsistency(null);
      return;
    }

    setLocationConsistency(computeLocationConsistency(projected.point, declaredSector));
  };

  return (
    <div className="dashboard-container">
      <header className={`dashboard-header ${isAlert ? 'alert' : ''}`}>
        <div>
          <h1 className="header-title">GEMEO DIGITAL <span>| COMMAND CENTER</span></h1>
          <p className="header-subtitle">{dataSource === 'live' ? 'LIVE DATA' : 'DEMO MODE'} | {telemetry.localizacao_otimizada?.zone || telemetry.localizacao_otimizada?.setor || 'Sem setor'}</p>
        </div>
        <div className="header-controls">
          <button onClick={() => setIs3DMode((value) => !value)} className={`btn-3d ${is3DMode ? 'active' : ''}`}>
            {is3DMode ? 'Modo 3D' : 'Modo Foco'}
          </button>
          <button onClick={startPatrol} className="btn-3d">Iniciar Patrulha</button>
          <button onClick={stopPatrol} className="btn-action" style={{ width: 'auto', padding: '0.5rem 1rem' }}>Parar Patrulha</button>
          <div className="status-block">
            <p className="status-label">Estado</p>
            <p className={`status-value ${isAlert || isRobotStopped ? 'alert' : ''}`}>{statusLabel}</p>
          </div>
        </div>
      </header>

      <main className="dashboard-grid">
        <section className={`panel ${isAlert ? 'alert' : ''}`} style={{ minHeight: '72vh' }}>
          <div className="panel-header">
            <h2 className="panel-title">Digital Twin 3D</h2>
            <span className="status-label">{telemetry.id_alerta}</span>
          </div>

          <div className="map-container" style={{ minHeight: '60vh' }}>
            <Canvas
              shadows={false}
              dpr={[1, 1.5]}
              camera={{ position: [9, 7, 9], fov: 42 }}
            >
              <color attach="background" args={[isAlert ? '#160809' : '#020617']} />
              <ambientLight intensity={1.8} />
              <directionalLight position={[8, 12, 6]} intensity={1.8} />
              <pointLight position={[-6, 6, -4]} intensity={1.2} />
              <Grid
                args={[24, 24]}
                cellSize={0.8}
                cellThickness={0.5}
                cellColor={isAlert ? '#7f1d1d' : '#1d4ed8'}
                sectionSize={4}
                sectionThickness={1}
                sectionColor={isAlert ? '#ef4444' : '#60a5fa'}
                fadeDistance={30}
                fadeStrength={1}
                position={[0, 0, 0]}
              />

              <Suspense fallback={<SceneFallback />}>
                <UsinaModel />
              </Suspense>

              <RobotAMR
                x={x3d}
                y={y3d}
                z={z3d}
                isAlert={isAlert}
                isStopped={isRobotStopped}
                onPositionUpdate={handlePositionUpdate}
              />

              <OrbitControls
                enablePan={false}
                maxPolarAngle={Math.PI / 2.1}
                minDistance={6}
                maxDistance={15}
                autoRotate={is3DMode && !isAlert}
                autoRotateSpeed={0.5}
              />
            </Canvas>
          </div>
        </section>

        <section className={`panel ${isAlert ? 'alert' : ''}`}>
          <div className="panel-header">
            <h2 className="panel-title">Telemetria</h2>
            <span className="status-label">{new Date(telemetry.timestamp).toLocaleTimeString('pt-BR')}</span>
          </div>

          <div style={{ display: 'grid', gap: '1rem' }}>
            <div>
              <p className="status-label">Feed da Camera</p>
              <div className="video-frame">
                <div className={`video-bg ${isAlert ? 'alert' : 'normal'}`} />
                {isAlert && (
                  <div className="bounding-box">
                    <div className="bb-label">
                      {telemetry.evento?.toUpperCase()} {(telemetry.confianca * 100).toFixed(0)}%
                    </div>
                  </div>
                )}
                <div style={{ position: 'relative', zIndex: 11, textAlign: 'center' }}>
                  <p className="status-value" style={{ marginBottom: '0.25rem' }}>AMR CAM 01</p>
                  <p className="status-label" style={{ color: '#e2e8f0' }}>
                    {isAlert ? 'Deteccao ativa na area monitorada' : 'Patrulha visual em andamento'}
                  </p>
                </div>
              </div>
            </div>

            <div>
              <p className="status-label">Evento</p>
              <p className={`status-value ${isAlert ? 'alert' : ''}`}>{telemetry.evento?.toUpperCase() || 'NORMAL'}</p>
            </div>

            <div>
              <p className="status-label">Confianca</p>
              <p className="header-title" style={{ fontSize: '1.2rem' }}>{(telemetry.confianca * 100).toFixed(1)}%</p>
            </div>

            <div>
              <p className="status-label">Setor</p>
              <p style={{ margin: 0, fontSize: '1rem' }}>{telemetry.localizacao_otimizada?.zone || telemetry.localizacao_otimizada?.setor || 'Nao informado'}</p>
            </div>

            <div>
              <p className="status-label">Consistencia de localizacao</p>
              <p style={{ margin: 0, fontSize: '1rem', color: locationConsistency !== null && locationConsistency < 0.6 ? '#f87171' : '#34d399' }}>
                {locationConsistency === null ? 'Calculando...' : `${(locationConsistency * 100).toFixed(1)}%`}
              </p>
            </div>

            <div>
              <p className="status-label">Analise automatica</p>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.5rem', padding: '1rem', lineHeight: 1.5 }}>
                {telemetry.llm_prompt || 'Sem relatorio disponivel.'}
              </div>
            </div>

            <button onClick={handleAlert} className="btn-action">Confirmar Alerta e Parar Robo</button>
          </div>
        </section>
      </main>
    </div>
  );
}
