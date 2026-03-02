    // ============================================================
    //  MÓDULO: WEB SERIAL MANAGER
    // ============================================================
    const SerialManager = (() => {
        let port = null;
        let reader = null;
        let writer = null;
        let readBuffer = '';
        let isConnected = false;

        function updateUI(connected) {
            isConnected = connected;
            document.getElementById('btnConnect').classList.toggle('hidden', connected);
            document.getElementById('btnDisconnect').classList.toggle('hidden', !connected);
            document.getElementById('btnStart').disabled = !connected;
            document.getElementById('btnWaveOn').disabled = !connected;
            document.getElementById('btnList').disabled = !connected;

            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            const indicator = document.getElementById('connStatus');
            if (connected) {
                dot.className = 'status-dot connected';
                text.textContent = 'ESP32 ONLINE';
                indicator.classList.add('conn-online');
            } else {
                dot.className = 'status-dot';
                text.textContent = 'DESCONECTADO';
                indicator.classList.remove('conn-online');
            }
        }

        let userClosed  = false;
        let reconnTimer = null;

        async function openPort(p) {
            port = p;
            await port.open({ baudRate: 921600 });
            writer = port.writable.getWriter();
            updateUI(true);
            logSerial('SISTEMA', 'ESP32-S3 conectado por USB');
            readLoop();
        }

        async function connect() {
            if (!('serial' in navigator)) {
                alert('Web Serial API no soportada. Usa Chrome/Edge.');
                return;
            }
            try {
                userClosed = false;
                const p = await navigator.serial.requestPort();
                await openPort(p);
            } catch (e) {
                logSerial('ERROR', e.message);
            }
        }

        async function disconnect() {
            userClosed = true;
            clearTimeout(reconnTimer);
            try {
                if (reader) { await reader.cancel(); reader = null; }
                if (writer) { writer.releaseLock(); writer = null; }
                if (port)   { await port.close(); port = null; }
            } catch (e) { /* ignorar */ }
            updateUI(false);
            logSerial('SISTEMA', 'Desconectado');
        }

        async function tryReconnect() {
            if (userClosed) return;
            logSerial('SISTEMA', 'Reconectando...');
            try {
                const ports = await navigator.serial.getPorts();
                if (ports.length === 0) {
                    logSerial('ERROR', 'Puerto no encontrado. Reconecta manualmente.');
                    updateUI(false);
                    return;
                }
                await new Promise(r => setTimeout(r, 1500));
                await openPort(ports[0]);
                logSerial('SISTEMA', 'Reconectado automaticamente');
            } catch (e) {
                logSerial('SISTEMA', 'Reintentando en 2s...');
                reconnTimer = setTimeout(tryReconnect, 2000);
            }
        }

        async function readLoop() {
            const decoder = new TextDecoder();
            try {
                while (port && port.readable) {
                    reader = port.readable.getReader();
                    try {
                        while (true) {
                            const { value, done } = await reader.read();
                            if (done) break;
                            readBuffer += decoder.decode(value, { stream: true });
                            processBuffer();
                        }
                    } finally {
                        reader.releaseLock();
                    }
                }
            } catch (e) {
                // ignorar cancelaciones intencionales
            }

            if (!userClosed) {
                updateUI(false);
                logSerial('SISTEMA', 'Conexion perdida. Reconectando...');
                reconnTimer = setTimeout(tryReconnect, 1500);
            }
        }

        function processBuffer() {
            const lines = readBuffer.split('\n');
            readBuffer = lines.pop(); // Guardar línea incompleta
            lines.forEach(line => {
                const trimmed = line.trim();
                if (!trimmed) return;
                try {
                    const msg = JSON.parse(trimmed);
                    handleMessage(msg);
                } catch (e) {
                    // No es JSON válido, ignorar
                }
            });
        }

        async function send(cmd) {
            if (!writer) { logSerial('ERROR', 'No conectado'); return; }
            const encoded = new TextEncoder().encode(cmd + '\n');
            await writer.write(encoded);
            logSerial('TX', cmd);
        }

        return { connect, disconnect, send, get isConnected() { return isConnected; } };
    })();

    // ============================================================
    //  MÓDULO: MANEJO DE MENSAJES ENTRANTES
    // ============================================================
    function handleMessage(msg) {
        switch (msg.type) {
            case 'rms':
                Gauges.update(msg.voltage, msg.current, msg.power);
                break;
            case 'wave':
                Oscilloscope.pushSamples(msg.samples);
                break;
            case 'list':
                FileManager.renderFileList(msg.files);
                break;
            case 'file_data':
                FileManager.receiveFileData(msg.content);
                break;
            case 'file_start':
                FileManager.startReceiving(msg.name, msg.size);
                logSerial('RX', `Recibiendo: ${msg.name} (${msg.size} bytes)`);
                break;
            case 'file_end':
                FileManager.finishReceiving();
                break;
            case 'ack':
                logSerial('ACK', `[${msg.cmd}] ${msg.msg}`);
                if (msg.cmd === 'START') {
                    document.getElementById('sessionInfo').textContent = `Sesion activa: ${msg.msg}`;
                    document.getElementById('btnStop').disabled = false;
                    document.getElementById('btnStart').disabled = true;
                } else if (msg.cmd === 'STOP') {
                    document.getElementById('sessionInfo').textContent = 'Sesión finalizada';
                    document.getElementById('btnStop').disabled = true;
                    document.getElementById('btnStart').disabled = false;
                }
                break;
            case 'error':
                logSerial('ERROR', msg.msg);
                break;
            case 'status':
            case 'boot':
                logSerial('INFO', msg.msg || JSON.stringify(msg));
                break;
        }
    }

    // ============================================================
    //  MÓDULO: SESIÓN
    // ============================================================
    const Session = {
        start() { SerialManager.send('START'); },
        stop()  { SerialManager.send('STOP'); },
        waveOn() {
            SerialManager.send('WAVE_ON');
            document.getElementById('btnWaveOn').classList.add('hidden');
            document.getElementById('btnWaveOff').classList.remove('hidden');
            document.getElementById('oscActive').textContent = '● ACTIVO';
            document.getElementById('oscActive').classList.add('wave-live');
        },
        waveOff() {
            SerialManager.send('WAVE_OFF');
            document.getElementById('btnWaveOff').classList.add('hidden');
            document.getElementById('btnWaveOn').classList.remove('hidden');
            document.getElementById('oscActive').textContent = '● INACTIVO';
            document.getElementById('oscActive').classList.remove('wave-live');
        }
    };

    // ============================================================
    //  MÓDULO: GAUGES (Canvas analógico tipo velocímetro)
    // ============================================================
    const Gauges = (() => {
        const configs = {
            voltage: {
                canvas: null, ctx: null,
                min: 0, max: 250, value: 0, targetValue: 0,
                label: 'V', zones: [
                    { start: 0,   end: 0.4, color: '#ef4444' },  // rojo: 0-100V
                    { start: 0.4, end: 0.6, color: '#f59e0b' },  // amarillo: 100-150V
                    { start: 0.6, end: 0.9, color: '#10b981' },  // verde: 150-225V
                    { start: 0.9, end: 1.0, color: '#ef4444' },  // rojo: >225V
                ],
                displayId: 'valVoltage'
            },
            current: {
                canvas: null, ctx: null,
                min: 0, max: 20, value: 0, targetValue: 0,
                label: 'A', zones: [
                    { start: 0,   end: 0.6, color: '#10b981' },
                    { start: 0.6, end: 0.8, color: '#f59e0b' },
                    { start: 0.8, end: 1.0, color: '#ef4444' },
                ],
                displayId: 'valCurrent'
            },
            power: {
                canvas: null, ctx: null,
                min: 0, max: 3000, value: 0, targetValue: 0,
                label: 'W', zones: [
                    { start: 0,   end: 0.5, color: '#10b981' },
                    { start: 0.5, end: 0.75, color: '#f59e0b' },
                    { start: 0.75, end: 1.0, color: '#ef4444' },
                ],
                displayId: 'valPower'
            }
        };

        const START_ANGLE = Math.PI * 0.75;
        const END_ANGLE   = Math.PI * 2.25;
        const SWEEP       = END_ANGLE - START_ANGLE;

        function drawGauge(cfg) {
            const canvas = cfg.canvas;
            const ctx = cfg.ctx;
            const W = canvas.width, H = canvas.height;
            const cx = W / 2, cy = H * 0.72;
            const R = Math.min(W, H * 1.4) * 0.44;

            ctx.clearRect(0, 0, W, H);

            // Fondo del arco (track)
            ctx.beginPath();
            ctx.arc(cx, cy, R, START_ANGLE, END_ANGLE);
            ctx.strokeStyle = '#1a1d23';
            ctx.lineWidth = 14;
            ctx.lineCap = 'round';
            ctx.stroke();

            // Zonas de color
            cfg.zones.forEach(z => {
                const sa = START_ANGLE + SWEEP * z.start;
                const ea = START_ANGLE + SWEEP * z.end;
                ctx.beginPath();
                ctx.arc(cx, cy, R, sa, ea);
                ctx.strokeStyle = z.color + '55';
                ctx.lineWidth = 14;
                ctx.stroke();
            });

            // Arco de valor (animado)
            const t = (cfg.value - cfg.min) / (cfg.max - cfg.min);
            const clampT = Math.max(0, Math.min(1, t));
            const valAngle = START_ANGLE + SWEEP * clampT;

            if (clampT > 0) {
                // Gradiente dinámico según zona
                const grad = ctx.createConicalGradient
                    ? null // no nativo, usar color sólido
                    : null;

                let arcColor = '#3b82f6';
                for (const z of cfg.zones) {
                    if (clampT >= z.start && clampT <= z.end) {
                        arcColor = z.color;
                        break;
                    }
                }

                ctx.beginPath();
                ctx.arc(cx, cy, R, START_ANGLE, valAngle);
                ctx.strokeStyle = arcColor;
                ctx.lineWidth = 14;
                ctx.lineCap = 'round';
                ctx.shadowColor = arcColor;
                ctx.shadowBlur = 12;
                ctx.stroke();
                ctx.shadowBlur = 0;
            }

            // Marcas de escala
            const ticks = 10;
            for (let i = 0; i <= ticks; i++) {
                const a = START_ANGLE + SWEEP * (i / ticks);
                const isMain = i % 2 === 0;
                const r1 = R + 8, r2 = isMain ? R + 18 : R + 13;
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
                ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
                ctx.strokeStyle = isMain ? '#6b7280' : '#374151';
                ctx.lineWidth = isMain ? 2 : 1;
                ctx.stroke();

                if (isMain) {
                    const val = cfg.min + (cfg.max - cfg.min) * (i / ticks);
                    const tx = cx + Math.cos(a) * (r2 + 12);
                    const ty = cy + Math.sin(a) * (r2 + 12);
                    ctx.fillStyle = '#6b7280';
                    ctx.font = `bold 9px 'Share Tech Mono', monospace`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(val >= 1000 ? (val/1000).toFixed(1)+'k' : Math.round(val), tx, ty);
                }
            }

            // AGUJA
            const needleAngle = START_ANGLE + SWEEP * clampT;
            const needleLen = R - 8;
            const needleBase = 6;

            // Sombra de aguja
            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,0.6)';
            ctx.shadowBlur = 6;
            ctx.shadowOffsetX = 2;
            ctx.shadowOffsetY = 2;

            ctx.beginPath();
            ctx.moveTo(
                cx + Math.cos(needleAngle - 0.08) * needleBase,
                cy + Math.sin(needleAngle - 0.08) * needleBase
            );
            ctx.lineTo(
                cx + Math.cos(needleAngle) * needleLen,
                cy + Math.sin(needleAngle) * needleLen
            );
            ctx.lineTo(
                cx + Math.cos(needleAngle + 0.08) * needleBase,
                cy + Math.sin(needleAngle + 0.08) * needleBase
            );
            ctx.closePath();
            ctx.fillStyle = '#f3f4f6';
            ctx.fill();
            ctx.restore();

            // Perno central
            ctx.beginPath();
            ctx.arc(cx, cy, 7, 0, Math.PI * 2);
            ctx.fillStyle = '#374151';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#9ca3af';
            ctx.fill();
        }

        function animate() {
            Object.values(configs).forEach(cfg => {
                // Suavizado exponencial
                cfg.value += (cfg.targetValue - cfg.value) * 0.12;
                drawGauge(cfg);
            });
            requestAnimationFrame(animate);
        }

        function init() {
            ['voltage', 'current', 'power'].forEach(key => {
                const cfg = configs[key];
                cfg.canvas = document.getElementById(`gauge${key.charAt(0).toUpperCase() + key.slice(1)}`);
                cfg.ctx    = cfg.canvas.getContext('2d');
            });
            animate();
        }

        function update(v, i, p) {
            configs.voltage.targetValue = v;
            configs.current.targetValue = i;
            configs.power.targetValue   = p;

            document.getElementById('valVoltage').innerHTML = `${v.toFixed(1)}<span class="gauge-unit">V</span>`;
            document.getElementById('valCurrent').innerHTML = `${i.toFixed(2)}<span class="gauge-unit">A</span>`;
            document.getElementById('valPower').innerHTML   = `${p.toFixed(1)}<span class="gauge-unit">W</span>`;
        }

        return { init, update };
    })();

    // ============================================================
    //  MÓDULO: OSCILOSCOPIO (Canvas optimizado)
    // ============================================================
    const Oscilloscope = (() => {
        const MAX_POINTS = 1200;
        let canvas, ctx;
        let waveData = new Float32Array(MAX_POINTS);
        let writePos = 0;
        let totalPushed = 0;
        let running = false;
        const ADC_OFFSET = 1918, ADC_MAX = 4095;

        function init() {
            canvas = document.getElementById('oscCanvas');
            ctx = canvas.getContext('2d');
            // Esperar a que el contenedor tenga dimensiones reales
            setTimeout(() => {
                resize();
                drawIdle();
            }, 100);
            window.addEventListener('resize', () => {
                resize();
            });
        }

        function resize() {
            const container = canvas.parentElement;
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (w > 0 && h > 0) {
                canvas.width  = w;
                canvas.height = h;
            }
        }

        function pushSamples(samples) {
            samples.forEach(raw => {
                // Normalizar a rango -1 a +1
                waveData[writePos % MAX_POINTS] = (raw - ADC_OFFSET) / (ADC_MAX / 2);
                writePos++;
                totalPushed++;
            });
            if (!running) {
                running = true;
                requestAnimationFrame(draw);
            }
        }

        function drawGrid(W, H) {
            // Fondo
            ctx.fillStyle = '#08090d';
            ctx.fillRect(0, 0, W, H);

            // Grilla vertical y horizontal
            ctx.strokeStyle = 'rgba(40,46,58,0.9)';
            ctx.lineWidth = 1;
            const cols = 10, rows = 6;
            for (let i = 0; i <= cols; i++) {
                const x = Math.round((W / cols) * i) + 0.5;
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
            }
            for (let i = 0; i <= rows; i++) {
                const y = Math.round((H / rows) * i) + 0.5;
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
            }

            // Línea central más visible
            ctx.strokeStyle = 'rgba(59,130,246,0.2)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, H / 2);
            ctx.lineTo(W, H / 2);
            ctx.stroke();
        }

        function drawIdle() {
            if (!canvas.width || !canvas.height) { resize(); }
            const W = canvas.width, H = canvas.height;
            if (!W || !H) return;
            drawGrid(W, H);
            // Texto de espera
            ctx.fillStyle = 'rgba(100,116,139,0.6)';
            ctx.font = '12px "Share Tech Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText('Esperando datos — pulse OSCILOSCOPIO ON', W / 2, H / 2 + 30);
            ctx.textAlign = 'left';
        }

        function draw() {
            running = false;

            // Re-sincronizar tamaño si cambió
            const container = canvas.parentElement;
            if (canvas.width !== container.clientWidth && container.clientWidth > 0) {
                canvas.width  = container.clientWidth;
                canvas.height = container.clientHeight;
            }

            const W = canvas.width, H = canvas.height;
            if (!W || !H) return;

            drawGrid(W, H);

            const count = Math.min(totalPushed, MAX_POINTS);
            if (count < 2) return;

            const amp   = (H / 2) * 0.85;  // 85% de la mitad del canvas
            const startI = (writePos - count + MAX_POINTS * 10) % MAX_POINTS;

            ctx.beginPath();
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth   = 1.5;
            ctx.shadowColor = '#3b82f6';
            ctx.shadowBlur  = 6;
            ctx.lineJoin    = 'round';

            for (let i = 0; i < count; i++) {
                const x   = (i / (count - 1)) * W;
                const idx = (startI + i) % MAX_POINTS;
                const y   = H / 2 - waveData[idx] * amp;
                if (i === 0) ctx.moveTo(x, y);
                else         ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.shadowBlur = 0;

            // Seguir animando mientras haya datos recientes
            running = true;
            requestAnimationFrame(draw);
        }

        return { init, pushSamples };
    })();

    // ============================================================
    //  MÓDULO: FILE MANAGER
    // ============================================================
    const FileManager = (() => {
        let receivingName = '';
        let receivingContent = '';

        function listFiles() {
            SerialManager.send('LIST');
        }

        function renderFileList(files) {
            const container = document.getElementById('fileList');
            if (!files || files.length === 0) {
                container.innerHTML = '<div class="file-empty">No hay archivos CSV en la microSD</div>';
                return;
            }
            container.innerHTML = files.map(f => `
                <div class="file-item">
                    <div class="file-info">
                        <span class="file-name">${f.name}</span>
                        <span class="file-size">${(f.size / 1024).toFixed(1)} KB</span>
                    </div>
                    <button class="file-btn" onclick="FileManager.downloadFile('${f.name}')">↓ DESCARGAR</button>
                </div>
            `).join('');
        }

        function downloadFile(name) {
            SerialManager.send(`READ ${name}`);
        }

        function startReceiving(name) {
            receivingName = name;
            receivingContent = '';
        }

        function receiveFileData(content) {
            receivingContent += content.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }

        function finishReceiving() {
            if (!receivingContent) return;

            // Disparar descarga
            const blob = new Blob([receivingContent], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = receivingName.replace('/', '');
            a.click();
            URL.revokeObjectURL(url);

            logSerial('INFO', `Archivo descargado: ${receivingName}`);

            // Parsear y mostrar estadísticas
            parseAndAnalyze(receivingContent);
        }

        function parseAndAnalyze(csv) {
            const lines = csv.trim().split('\n');
            if (lines.length < 2) return;

            const headers = lines[0].split(',');
            const vIdx = headers.indexOf('voltage_rms');
            const iIdx = headers.indexOf('current_rms');
            const pIdx = headers.indexOf('power');

            const voltages = [], currents = [], powers = [];
            const timestamps = [];

            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].split(',');
                if (parts.length < 4) continue;
                timestamps.push(parseFloat(parts[0]) / 1000);
                voltages.push(parseFloat(parts[vIdx]));
                currents.push(parseFloat(parts[iIdx]));
                powers.push(parseFloat(parts[pIdx]));
            }

            if (voltages.length === 0) return;

            const stats = (arr) => {
                const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
                const max = Math.max(...arr);
                const min = Math.min(...arr);
                const std = Math.sqrt(arr.reduce((a, b) => a + (b - avg) ** 2, 0) / arr.length);
                return { avg, max, min, std };
            };

            const sv = stats(voltages);
            const si = stats(currents);
            const sp = stats(powers);

            document.getElementById('statVavg').textContent = sv.avg.toFixed(1);
            document.getElementById('statVmax').textContent = sv.max.toFixed(1);
            document.getElementById('statVmin').textContent = sv.min.toFixed(1);
            document.getElementById('statVstd').textContent = sv.std.toFixed(2);
            document.getElementById('statIavg').textContent = si.avg.toFixed(3);
            document.getElementById('statPavg').textContent = sp.avg.toFixed(1);
            document.getElementById('statPmax').textContent = sp.max.toFixed(1);
            document.getElementById('statCount').textContent = voltages.length;

            HistoryChart.loadData(timestamps, voltages, currents, powers);
        }

        return { listFiles, renderFileList, downloadFile, startReceiving, receiveFileData, finishReceiving };
    })();

    // ============================================================
    //  MÓDULO: HISTORY CHART
    // ============================================================
    const HistoryChart = (() => {
        let chart = null;
        let data = { timestamps: [], voltage: [], current: [], power: [] };
        let currentMetric = 'voltage';

        const metricConfig = {
            voltage: { label: 'Voltaje RMS (V)', color: '#3b82f6', arr: () => data.voltage },
            current: { label: 'Corriente RMS (A)', color: '#10b981', arr: () => data.current },
            power:   { label: 'Potencia (W)',     color: '#f59e0b', arr: () => data.power   },
        };

        function init() {
            const ctx = document.getElementById('historyChart').getContext('2d');
            chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Voltaje RMS (V)',
                        data: [],
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59,130,246,0.08)',
                        borderWidth: 2,
                        pointRadius: 0,
                        fill: true,
                        tension: 0.3
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 400 },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            mode: 'index', intersect: false,
                            backgroundColor: '#1a1d23',
                            borderColor: '#2d3139',
                            borderWidth: 1,
                            titleColor: '#9ca3af',
                            bodyColor: '#f3f4f6',
                            titleFont: { family: 'Share Tech Mono' },
                            bodyFont:  { family: 'Share Tech Mono' }
                        }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#6b7280', font: { family: 'Share Tech Mono', size: 10 }, maxRotation: 0, autoSkipPadding: 20 },
                            grid: { color: '#1f2937' }
                        },
                        y: {
                            ticks: { color: '#6b7280', font: { family: 'Share Tech Mono', size: 10 } },
                            grid: { color: '#1f2937' }
                        }
                    }
                }
            });
        }

        function loadData(timestamps, voltage, current, power) {
            data = { timestamps, voltage, current, power };
            refreshChart();
        }

        function setMetric(metric, btn) {
            currentMetric = metric;
            document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            refreshChart();
        }

        function refreshChart() {
            if (!chart) return;
            const cfg = metricConfig[currentMetric];
            chart.data.labels = data.timestamps.map(t => `${t.toFixed(0)}s`);
            chart.data.datasets[0].data = cfg.arr()();
            chart.data.datasets[0].label = cfg.label;
            chart.data.datasets[0].borderColor = cfg.color;
            chart.data.datasets[0].backgroundColor = cfg.color + '14';
            chart.update();
        }

        function exportChart() {
            if (!chart) return;
            const url = chart.toBase64Image();
            const a = document.createElement('a');
            a.href = url;
            a.download = `grafica_${currentMetric}_${Date.now()}.png`;
            a.click();
        }

        return { init, loadData, setMetric, exportChart };
    })();

    // ============================================================
    //  LOG SERIAL
    // ============================================================
    function logSerial(type, msg) {
        const log = document.getElementById('serialLog');
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type.toLowerCase()}`;
        const time = new Date().toLocaleTimeString('es', { hour12: false });
        entry.textContent = `[${time}] [${type}] ${msg}`;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
        // Limitar a 200 entradas
        while (log.children.length > 200) log.removeChild(log.firstChild);
    }
    function clearLog() { document.getElementById('serialLog').innerHTML = ''; }

    // ============================================================
    //  INICIALIZACIÓN
    // ============================================================
    document.addEventListener('DOMContentLoaded', () => {
        // Sub-nav carrusel
        const container = document.getElementById('mainCarousel');
        const navButtons = document.querySelectorAll('.sub-nav-item');
        const sliderLine = document.querySelector('.slider-line');
        const sections   = document.querySelectorAll('.carousel-slide');

        function moveLineTo(btn) {
            if (!btn) return;
            navButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const pRect = btn.parentElement.getBoundingClientRect();
            const bRect = btn.getBoundingClientRect();
            sliderLine.style.transform = `translateX(${bRect.left - pRect.left}px)`;
            sliderLine.style.width = `${bRect.width}px`;
        }

        navButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const section = document.getElementById(btn.dataset.target);
                moveLineTo(btn);
                section.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
            });
        });

        const obs = new IntersectionObserver(entries => {
            entries.forEach(e => {
                if (e.isIntersecting) {
                    moveLineTo(document.querySelector(`.sub-nav-item[data-target="${e.target.id}"]`));
                }
            });
        }, { root: container, threshold: 0.6 });

        sections.forEach(s => obs.observe(s));
        setTimeout(() => moveLineTo(navButtons[0]), 200);
        window.addEventListener('resize', () => {
            const active = document.querySelector('.sub-nav-item.active');
            if (active) moveLineTo(active);
        });

        // Inicializar módulos visuales
        Gauges.init();
        Oscilloscope.init();
        HistoryChart.init();

        logSerial('SISTEMA', 'OVA Energy Monitor v1.0 — Listo. Conecte el ESP32-S3 por USB.');

        // Verificar soporte Web Serial
        if (!('serial' in navigator)) {
            logSerial('WARN', 'Web Serial API no detectada. Usa Chrome 89+ o Edge 89+');
        }
    });
