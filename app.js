const SIGNAL_COLORS = {
  red: '#db4e3f',
  blue: '#3f77e2',
  yellow: '#e5a92a',
  orange: '#dc7f22'
};
const KNOB_SENSITIVITY = 220;
const MIN_CURVE_DISTANCE = 40;
const CURVE_FACTOR = 0.45;
const SIGNAL_LEVEL_MULTIPLIER = 3.3;

class G2Knob extends HTMLElement {
  static observedAttributes = ['value', 'min', 'max'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:inline-grid; gap:4px; justify-items:center; user-select:none; }
        .wrap { position:relative; width:42px; height:42px; border-radius:50%; border:1px solid #111; background: radial-gradient(#7b7b7b, #4b4b4b); cursor: ns-resize; }
        .marker { position:absolute; top:5px; left:50%; width:0; height:0; border-left:5px solid transparent; border-right:5px solid transparent; border-bottom:8px solid #40db73; transform: translateX(-50%) rotate(var(--deg)); transform-origin: 50% 16px; }
        .label { font-size:10px; opacity:0.9; }
      </style>
      <div class="wrap"><div class="marker"></div></div>
      <div class="label"><slot></slot></div>
    `;
    this._pointerDown = null;
    this._value = Number(this.getAttribute('value') ?? 0.5);
  }

  connectedCallback() {
    this.shadowRoot.querySelector('.wrap').addEventListener('pointerdown', (event) => {
      this.setPointerCapture(event.pointerId);
      this._pointerDown = { x: event.clientX, y: event.clientY, value: this._value };
      this.dispatchEvent(new CustomEvent('g2-interaction', { bubbles: true, composed: true }));
    });

    this.addEventListener('pointermove', (event) => {
      if (!this._pointerDown) return;
      const delta = (this._pointerDown.y - event.clientY) + (event.clientX - this._pointerDown.x);
      this.value = Math.min(1, Math.max(0, this._pointerDown.value + (delta / KNOB_SENSITIVITY)));
      this.dispatch();
    });

    this.addEventListener('pointerup', () => {
      this._pointerDown = null;
    });
    this.render();
  }

  attributeChangedCallback() {
    this._value = Number(this.getAttribute('value') ?? this._value);
    this.render();
  }

  get value() {
    return this._value;
  }

  set value(next) {
    this._value = next;
    this.setAttribute('value', String(next));
    this.render();
  }

  get scaledValue() {
    const min = Number(this.getAttribute('min') ?? 0);
    const max = Number(this.getAttribute('max') ?? 1);
    return min + (max - min) * this._value;
  }

  dispatch() {
    this.dispatchEvent(new CustomEvent('g2-change', {
      detail: { normalized: this._value, value: this.scaledValue },
      bubbles: true,
      composed: true
    }));
  }

  render() {
    const deg = -135 + (this._value * 270);
    this.style.setProperty('--deg', `${deg}deg`);
  }
}

class G2Input extends HTMLElement {
  connectedCallback() {
    const color = this.getAttribute('color') || 'red';
    this.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:50%;background:${SIGNAL_COLORS[color] || SIGNAL_COLORS.red};border:1px solid #111;`;
  }
}

class G2Output extends HTMLElement {
  connectedCallback() {
    const color = this.getAttribute('color') || 'red';
    this.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:2px;background:${SIGNAL_COLORS[color] || SIGNAL_COLORS.red};border:1px solid #111;cursor:crosshair;`;
  }
}

customElements.define('g2-knob', G2Knob);
customElements.define('g2-input', G2Input);
customElements.define('g2-output', G2Output);

class ModuleLoader {
  async load(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Module fetch failed: ${path}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const template = doc.querySelector('template');
    const script = doc.querySelector('script[type="module"]');
    if (!template || !script) throw new Error(`Invalid module format: ${path}`);

    globalThis.__g2CurrentTemplate = template.innerHTML;
    const blob = new Blob([`${script.textContent}\n//# sourceURL=${path}`], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      await import(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
      delete globalThis.__g2CurrentTemplate;
    }
  }
}

class SynthHost {
  constructor() {
    this.voiceArea = document.getElementById('voice-area');
    this.fxArea = document.getElementById('fx-area');
    this.svg = document.getElementById('cable-layer');
    this.dragPath = document.getElementById('drag-cable');
    this.audioStatus = document.getElementById('audio-status');
    this.loader = new ModuleLoader();
    this.audioContext = null;
    this.connections = [];
    this.dragState = null;
    this.outputAnalyser = new Map();
    this.installSplitter();
    this.installCableEvents();
    this.renderLoop();
  }

  installSplitter() {
    const bar = document.getElementById('split-bar');
    bar.addEventListener('pointerdown', (start) => {
      const startY = start.clientY;
      const startHeight = this.voiceArea.getBoundingClientRect().height;
      const onMove = (event) => {
        const next = Math.max(120, startHeight + (event.clientY - startY));
        document.getElementById('app').style.gridTemplateRows = `48px ${next}px 6px 1fr`;
        this.updateCablePositions();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    });
  }

  async init() {
    await this.loader.load('/modules/InOut/2-Out.html');
    await this.loader.load('/modules/Osc/OscDual.html');
    await this.loader.load('/modules/Env/EnvADSR.html');
    await this.loader.load('/modules/Filter/FltClassic.html');

    this.addModule('g2-osc-dual', this.voiceArea, 36, 42);
    this.addModule('g2-env-adsr', this.voiceArea, 256, 42);
    this.addModule('g2-flt-classic', this.fxArea, 36, 40);
    this.addModule('g2-two-out', this.fxArea, 286, 40);

    document.addEventListener('pointerdown', () => this.ensureAudioContext(), { passive: true });
    document.addEventListener('g2-interaction', () => this.ensureAudioContext());
    window.addEventListener('resize', () => this.updateCablePositions());
  }

  addModule(tagName, mount, x, y) {
    const wrapper = document.createElement('div');
    wrapper.className = 'module-host';
    wrapper.style.left = `${x}px`;
    wrapper.style.top = `${y}px`;
    const module = document.createElement(tagName);
    wrapper.appendChild(module);
    mount.appendChild(wrapper);
  }

  ensureAudioContext() {
    if (this.audioContext) return this.audioContext;
    this.audioContext = new AudioContext();
    this.audioStatus.textContent = `AudioContext: ${this.audioContext.state}`;
    this.audioStatus.style.color = '#7de990';
    this.voiceArea.querySelectorAll('.module-host > *').forEach((el) => el.bindAudioContext?.(this.audioContext));
    this.fxArea.querySelectorAll('.module-host > *').forEach((el) => el.bindAudioContext?.(this.audioContext));
    return this.audioContext;
  }

  installCableEvents() {
    document.addEventListener('pointerdown', (event) => {
      const output = event.target.closest('g2-output');
      if (!output) return;
      this.dragState = { output, x: event.clientX, y: event.clientY };
      this.drawDragCable(output, event.clientX, event.clientY);
      this.highlightConnected(output, true);
    });

    document.addEventListener('pointermove', (event) => {
      if (!this.dragState) return;
      this.drawDragCable(this.dragState.output, event.clientX, event.clientY);
    });

    document.addEventListener('pointerup', (event) => {
      if (!this.dragState) return;
      const input = event.target.closest('g2-input');
      const output = this.dragState.output;
      this.dragPath.setAttribute('d', '');
      this.highlightConnected(output, false);
      this.dragState = null;
      if (!input) return;
      this.createConnection(output, input);
    });
  }

  highlightConnected(output, active) {
    this.connections.filter((c) => c.output === output).forEach((c) => c.path.classList.toggle('highlight', active));
  }

  createConnection(output, input) {
    const existing = this.connections.find((c) => c.input === input);
    if (existing) {
      existing.disconnect?.();
      existing.path.remove();
      this.connections = this.connections.filter((c) => c !== existing);
    }

    const color = output.getAttribute('color') || 'red';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', `cable ${color}`);
    path.style.color = SIGNAL_COLORS[color] || SIGNAL_COLORS.red;

    const connection = { output, input, path, disconnect: null };
    this.connections.push(connection);
    this.svg.appendChild(path);
    this.patchAudio(connection);
    this.updateConnectionPath(connection);
  }

  patchAudio(connection) {
    const context = this.ensureAudioContext();
    const sourceModule = connection.output.getRootNode().host;
    const targetModule = connection.input.getRootNode().host;
    const sourceNode = sourceModule?.getOutputNode?.(connection.output.getAttribute('port'));
    const toPort = connection.input.getAttribute('port');

    if (!sourceNode || !targetModule) return;

    try {
      const targetParam = targetModule.getInputParam?.(toPort);
      const targetNode = targetModule.getInputNode?.(toPort);
      if (targetParam) {
        sourceNode.connect(targetParam);
        connection.disconnect = () => sourceNode.disconnect(targetParam);
      } else if (targetNode) {
        sourceNode.connect(targetNode);
        connection.disconnect = () => sourceNode.disconnect(targetNode);
      }
    } catch (error) {
      console.warn('Audio connection fallback:', error);
      const fallback = context.createGain();
      fallback.gain.value = 1;
      const targetNode = targetModule.getInputNode?.(toPort);
      if (!targetNode) return;
      sourceNode.connect(fallback).connect(targetNode);
      connection.disconnect = () => {
        sourceNode.disconnect(fallback);
        fallback.disconnect(targetNode);
      };
    }

    if (!this.outputAnalyser.has(connection.output)) {
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      sourceNode.connect(analyser);
      this.outputAnalyser.set(connection.output, analyser);
    }
  }

  drawDragCable(output, x, y) {
    const rect = output.getBoundingClientRect();
    const startX = rect.left + (rect.width / 2);
    const startY = rect.top + (rect.height / 2);
    this.dragPath.setAttribute('d', this.makeCurve(startX, startY, x, y));
  }

  makeCurve(x1, y1, x2, y2) {
    const dx = Math.max(MIN_CURVE_DISTANCE, Math.abs(x2 - x1) * CURVE_FACTOR);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  updateConnectionPath(connection) {
    const a = connection.output.getBoundingClientRect();
    const b = connection.input.getBoundingClientRect();
    connection.path.setAttribute(
      'd',
      this.makeCurve(
        a.left + (a.width / 2),
        a.top + (a.height / 2),
        b.left + (b.width / 2),
        b.top + (b.height / 2)
      )
    );
  }

  updateCablePositions() {
    this.connections.forEach((connection) => this.updateConnectionPath(connection));
  }

  renderLoop() {
    this.connections.forEach((connection) => {
      const analyser = this.outputAnalyser.get(connection.output);
      if (!analyser) return;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += Math.abs((data[i] - 128) / 128);
      const level = Math.min(1, (sum / data.length) * SIGNAL_LEVEL_MULTIPLIER);
      connection.path.style.setProperty('--flow', String(level));
      if ((connection.output.getAttribute('color') || '') === 'yellow') {
        connection.path.style.opacity = level > 0.1 ? '1' : '0.45';
      }
    });
    requestAnimationFrame(() => this.renderLoop());
  }
}

const host = new SynthHost();
host.init();
