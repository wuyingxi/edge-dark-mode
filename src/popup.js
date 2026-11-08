(() => {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'auto',
    brightness: 100,
    contrast: 100,
    saturation: 100,
    siteRules: {}
  });

  const PREVIEW_KEY = '__edm_preview_settings';
  const hasExtensionApi = Boolean(
    globalThis.chrome && chrome.storage && chrome.storage.local
  );

  const $ = (id) => document.getElementById(id);

  let settings = { ...DEFAULTS, siteRules: {} };
  let hostKey = null;
  let hostLabel = '读取中…';
  let supported = false;
  let saveTimer = 0;

  /* ------------------------------------------------------------------ */
  /* 设置                                                                */
  /* ------------------------------------------------------------------ */

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function normalize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const rules = {};
    if (source.siteRules && typeof source.siteRules === 'object') {
      for (const [key, value] of Object.entries(source.siteRules)) {
        if (typeof key === 'string' && (value === 'auto' || value === 'on' || value === 'off')) {
          rules[key] = value;
        }
      }
    }
    return {
      enabled: source.enabled !== false,
      mode: source.mode === 'always' ? 'always' : 'auto',
      brightness: clamp(source.brightness, 70, 130, 100),
      contrast: clamp(source.contrast, 80, 130, 100),
      saturation: clamp(source.saturation, 50, 150, 100),
      siteRules: rules
    };
  }

  async function readSettings() {
    if (!hasExtensionApi) {
      try {
        const stored = JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null');
        return normalize(stored || DEFAULTS);
      } catch {
        return normalize(DEFAULTS);
      }
    }
    try {
      return normalize(await chrome.storage.local.get(DEFAULTS));
    } catch {
      return normalize(DEFAULTS);
    }
  }

  async function saveNow() {
    try {
      if (hasExtensionApi) await chrome.storage.local.set({ ...settings });
      else localStorage.setItem(PREVIEW_KEY, JSON.stringify(settings));
    } catch {
      /* 忽略写入失败，界面仍可继续使用。 */
    }
  }

  function persist(immediate) {
    clearTimeout(saveTimer);
    if (immediate) {
      void saveNow();
      return;
    }
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      void saveNow();
    }, 70);
  }

  /* ------------------------------------------------------------------ */
  /* 当前页面                                                            */
  /* ------------------------------------------------------------------ */

  function siteFromUrl(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.hostname.toLowerCase().replace(/^www\./, '') || null;
      }
      if (parsed.protocol === 'file:') return '__file__';
    } catch {
      /* 忽略 */
    }
    return null;
  }

  async function getActiveTab() {
    if (!hasExtensionApi || !chrome.tabs || !chrome.tabs.query) {
      return { url: 'https://example.com/article' };
    }
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch {
      return null;
    }
  }

  async function resolveSite(tab) {
    if (!tab) {
      hostLabel = '无法读取当前页面';
      supported = false;
      return;
    }

    let key = siteFromUrl(tab.url);
    let label = key === '__file__' ? '本地文件' : key;

    if (!key && tab.id != null && hasExtensionApi) {
      try {
        const state = await chrome.tabs.sendMessage(tab.id, { type: 'EDM_GET_STATE' });
        if (state && state.ok && state.siteKey) {
          key = state.siteKey;
          label = state.host || key;
        }
      } catch {
        /* 受限页面没有内容脚本 */
      }
    }

    hostKey = key || null;
    hostLabel = label || '当前页面不支持';
    supported = Boolean(hostKey);
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function currentRule() {
    if (!hostKey) return 'auto';
    return settings.siteRules[hostKey] || 'auto';
  }

  function renderEnabled() {
    const checkbox = $('enabled');
    checkbox.checked = settings.enabled;
    $('app').classList.toggle('is-paused', !settings.enabled);
  }

  function renderMode() {
    document.querySelectorAll('#modeSeg button[data-mode]').forEach((button) => {
      const active = button.dataset.mode === settings.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function paintSlider(id) {
    const input = $(id);
    const output = $(id + 'Out');
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(settings[id]);
    input.value = String(value);
    output.textContent = `${value}%`;
    const percent = ((value - min) / (max - min)) * 100;
    input.style.setProperty('--fill', `${percent.toFixed(1)}%`);
  }

  function renderSliders() {
    paintSlider('brightness');
    paintSlider('contrast');
    paintSlider('saturation');
  }

  function renderSite() {
    $('siteHost').textContent = hostLabel;
    $('siteHost').title = hostLabel;

    const chip = $('siteChip');
    chip.classList.remove('is-on', 'is-off');

    if (!supported) {
      chip.textContent = '不可用';
    } else if (!settings.enabled) {
      chip.textContent = '已暂停';
    } else if (currentRule() === 'off') {
      chip.textContent = '已关闭';
      chip.classList.add('is-off');
    } else if (currentRule() === 'on') {
      chip.textContent = '已强制';
      chip.classList.add('is-on');
    } else {
      chip.textContent = '跟随全局';
    }

    document.querySelectorAll('#siteSeg button[data-rule]').forEach((button) => {
      const active = supported && button.dataset.rule === currentRule();
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = !supported;
    });
  }

  function renderStatus() {
    const status = $('status');
    let text = '';
    let paused = false;

    if (!settings.enabled) {
      text = '已暂停 · 网页保持原样';
      paused = true;
    } else if (!supported) {
      text = '当前页面无法注入，切换普通网页后生效';
    } else if (currentRule() === 'off') {
      text = '此网站已关闭暗色';
    } else if (currentRule() === 'on') {
      text = '此网站已强制暗色';
    } else if (settings.mode === 'always') {
      text = '强制模式 · 所有网页反色';
    } else {
      text = '智能模式 · 自动跳过原生深色网站';
    }

    $('statusText').textContent = text;
    status.classList.toggle('is-paused', paused);
  }

  function renderAll() {
    renderEnabled();
    renderMode();
    renderSliders();
    renderSite();
    renderStatus();
  }

  /* ------------------------------------------------------------------ */
  /* 交互                                                                */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    $('enabled').addEventListener('change', (event) => {
      settings.enabled = event.target.checked;
      renderEnabled();
      renderSite();
      renderStatus();
      persist(true);
    });

    $('modeSeg').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-mode]');
      if (!button) return;
      settings.mode = button.dataset.mode === 'always' ? 'always' : 'auto';
      renderMode();
      renderStatus();
      persist(true);
    });

    for (const id of ['brightness', 'contrast', 'saturation']) {
      const input = $(id);
      input.addEventListener('input', () => {
        settings[id] = Number(input.value);
        paintSlider(id);
        persist(false);
      });
      input.addEventListener('change', () => persist(true));
    }

    $('siteSeg').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-rule]');
      if (!button || !supported) return;

      const rule = button.dataset.rule;
      const rules = { ...settings.siteRules };
      if (rule === 'auto') delete rules[hostKey];
      else rules[hostKey] = rule;

      settings.siteRules = rules;
      renderSite();
      renderStatus();
      persist(true);
    });

    $('reset').addEventListener('click', () => {
      settings = {
        ...settings,
        enabled: true,
        mode: 'auto',
        brightness: 100,
        contrast: 100,
        saturation: 100
      };
      renderAll();
      persist(true);
    });

    window.addEventListener('pagehide', () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = 0;
        void saveNow();
      }
    });

    if (hasExtensionApi && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.siteRules) return;
        settings.siteRules = changes.siteRules.newValue || {};
        renderSite();
        renderStatus();
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function init() {
    settings = await readSettings();
    const tab = await getActiveTab();
    await resolveSite(tab);

    try {
      if (hasExtensionApi && chrome.runtime && chrome.runtime.getManifest) {
        $('version').textContent = `v${chrome.runtime.getManifest().version}`;
      }
    } catch {
      /* 忽略 */
    }

    renderAll();
    bindEvents();
  }

  init();
})();
