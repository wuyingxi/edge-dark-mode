(() => {
  'use strict';

  if (window.__EDM_LOADED__) return;
  window.__EDM_LOADED__ = true;

  const IS_TOP = (() => {
    try {
      return window.top === window.self;
    } catch {
      return false;
    }
  })();

  const DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'auto',
    brightness: 100,
    contrast: 100,
    saturation: 100,
    siteRules: {}
  });

  const ATTR = 'data-edm-dark';
  const CANCEL_ATTR = 'data-edm-cancel';
  const MEDIA_ATTR = 'data-edm-media';
  const ROOT = document.documentElement;
  const HOSTNAME = (location.hostname || '').toLowerCase().replace(/^www\./, '');
  const SITE_KEY = HOSTNAME || (location.protocol === 'file:' ? '__file__' : '');
  const DARK_LUMA = 0.3;
  const DEEP_DARK_LUMA = 0.32;

  let settings = {
    enabled: true,
    mode: 'auto',
    brightness: 100,
    contrast: 100,
    saturation: 100,
    siteRules: {}
  };
  let allow = false;
  let parentParity = 0;
  let netParity = 0;
  let hasParentState = IS_TOP;
  let ready = false;
  let deepTimer = 0;
  let toastTimer = 0;

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

  function readSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(DEFAULTS, (value) => {
          void chrome.runtime.lastError;
          resolve(normalize(value));
        });
      } catch {
        resolve(normalize(DEFAULTS));
      }
    });
  }

  function siteRule() {
    return settings.siteRules[SITE_KEY] || 'auto';
  }

  /* ------------------------------------------------------------------ */
  /* 滤镜开关                                                            */
  /* ------------------------------------------------------------------ */

  function setVariables() {
    if (!ROOT) return;
    ROOT.style.setProperty('--edm-brightness', (settings.brightness / 100).toFixed(3));
    ROOT.style.setProperty('--edm-contrast', (settings.contrast / 100).toFixed(3));
    ROOT.style.setProperty('--edm-saturation', (settings.saturation / 100).toFixed(3));
  }

  function setOverlay(active, cancel) {
    if (!ROOT) return;
    if (active) {
      setVariables();
      ROOT.setAttribute(ATTR, '1');
      if (cancel) ROOT.setAttribute(CANCEL_ATTR, '1');
      else ROOT.removeAttribute(CANCEL_ATTR);
    } else {
      ROOT.removeAttribute(ATTR);
      ROOT.removeAttribute(CANCEL_ATTR);
    }
  }

  function setMediaFilter(active) {
    if (!ROOT) return;
    if (active) ROOT.setAttribute(MEDIA_ATTR, '1');
    else ROOT.removeAttribute(MEDIA_ATTR);
  }

  function clearAll() {
    setOverlay(false, false);
    setMediaFilter(false);
    netParity = 0;
  }

  /* ------------------------------------------------------------------ */
  /* 页面底色检测                                                        */
  /* ------------------------------------------------------------------ */

  function parseColor(value) {
    if (!value || value === 'transparent') return [0, 0, 0, 0];
    const match = value.match(/^rgba?\((.+)\)$/i);
    if (!match) return null;
    const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }

  function composite(foreground, background) {
    const fa = foreground[3];
    const ba = background[3];
    const alpha = fa + ba * (1 - fa);
    if (alpha <= 0) return [0, 0, 0, 0];
    return [
      (foreground[0] * fa + background[0] * ba * (1 - fa)) / alpha,
      (foreground[1] * fa + background[1] * ba * (1 - fa)) / alpha,
      (foreground[2] * fa + background[2] * ba * (1 - fa)) / alpha,
      alpha
    ];
  }

  function relativeLuminance(color) {
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
  }

  function backgroundAt(element) {
    const chain = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      chain.push(node);
    }
    let color = [255, 255, 255, 1];
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const own = parseColor(getComputedStyle(chain[index]).backgroundColor);
      if (own && own[3] > 0.001) color = composite(own, color);
    }
    return color;
  }

  function declaresOnlyDarkScheme() {
    if (!ROOT) return false;
    const scheme = getComputedStyle(ROOT).colorScheme || '';
    if (/(^|\s)dark(\s|$)/.test(scheme) && !/(^|\s)light(\s|$)/.test(scheme)) return true;

    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) {
      const content = meta.getAttribute('content') || '';
      if (/(^|\s)dark(\s|$)/i.test(content) && !/(^|\s)light(\s|$)/i.test(content)) return true;
    }
    return false;
  }

  function pageLooksDark() {
    const body = document.body;
    if (!body || !ROOT) return false;

    const bodyColor = parseColor(getComputedStyle(body).backgroundColor);
    const rootColor = parseColor(getComputedStyle(ROOT).backgroundColor);
    const hasOwnBackground =
      Boolean(bodyColor && bodyColor[3] > 0.5) || Boolean(rootColor && rootColor[3] > 0.5);

    if (!hasOwnBackground && declaresOnlyDarkScheme()) return true;

    return relativeLuminance(backgroundAt(body)) < DARK_LUMA;
  }

  function deepLooksDark() {
    if (!document.body || !ROOT) return false;

    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width < 40 || height < 40) return false;

    const points = [
      [width / 2, height / 2],
      [width / 2, height * 0.18],
      [width * 0.07, height / 2],
      [width * 0.93, height / 2],
      [width / 2, height * 0.82]
    ];

    let dark = 0;
    let total = 0;
    for (const [x, y] of points) {
      const element = document.elementFromPoint(x, y);
      if (!element) continue;
      total += 1;
      if (relativeLuminance(backgroundAt(element)) < DEEP_DARK_LUMA) dark += 1;
    }

    return total >= 3 && dark >= Math.ceil(total * 0.6);
  }

  function pageIsLight(deep) {
    return !(pageLooksDark() || (deep && deepLooksDark()));
  }

  /* ------------------------------------------------------------------ */
  /* 父子页面（iframe）状态同步                                          */
  /* ------------------------------------------------------------------ */

  function frameState() {
    return {
      __edm: true,
      type: 'state',
      allow: Boolean(allow),
      parity: netParity,
      brightness: settings.brightness,
      contrast: settings.contrast,
      saturation: settings.saturation
    };
  }

  function forEachChildFrame(callback) {
    let frames;
    try {
      frames = document.querySelectorAll('iframe, frame');
    } catch {
      return;
    }
    for (const frame of frames) {
      try {
        if (frame.contentWindow) callback(frame.contentWindow);
      } catch {
        /* 跨域访问失败时忽略 */
      }
    }
  }

  function broadcastState() {
    if (!hasParentState) return;
    const state = frameState();
    forEachChildFrame((target) => target.postMessage(state, '*'));
  }

  function sendStateTo(target) {
    if (!target) return;
    try {
      target.postMessage(frameState(), '*');
    } catch {
      /* 忽略 */
    }
  }

  function installFrameMessaging() {
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.__edm !== true) return;

      if (IS_TOP && data.type === 'hello') {
        sendStateTo(event.source);
        return;
      }

      if (!IS_TOP && data.type === 'state') {
        applyParentState(data);
      }
    });

    document.addEventListener('load', (event) => {
      const target = event.target;
      if (!target || (target.tagName !== 'IFRAME' && target.tagName !== 'FRAME')) return;
      try {
        if (target.contentWindow) target.contentWindow.postMessage(frameState(), '*');
      } catch {
        /* 忽略 */
      }
    }, true);
  }

  function sayHello() {
    try {
      window.top.postMessage({ __edm: true, type: 'hello' }, '*');
    } catch {
      /* 忽略 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* iframe 内的页面：根据父级反色层数决定自己补哪一层                   */
  /* ------------------------------------------------------------------ */

  function applyParentState(state) {
    const nextAllow = Boolean(state.allow);
    const nextParity = state.parity === 1 ? 1 : 0;
    const structural = !hasParentState || nextAllow !== allow || nextParity !== parentParity;

    allow = nextAllow;
    parentParity = nextParity;
    hasParentState = true;

    settings = {
      ...settings,
      brightness: clamp(state.brightness, 70, 130, 100),
      contrast: clamp(state.contrast, 80, 130, 100),
      saturation: clamp(state.saturation, 50, 150, 100)
    };

    if (!allow) {
      clearAll();
      broadcastState();
      return;
    }

    if (!document.body) {
      onBodyReady(() => evaluateFrame(true));
      return;
    }

    if (structural) {
      evaluateFrame(true);
    } else {
      if (ROOT && ROOT.getAttribute(ATTR) === '1') setVariables();
      broadcastState();
    }
  }

  function evaluateFrame(deep) {
    if (!hasParentState || !allow || !document.body) return;

    const light = pageIsLight(deep);
    const ownOverlay = light !== (parentParity === 1);
    const cancel = !light && parentParity === 1;

    setOverlay(ownOverlay, cancel);
    setMediaFilter(light);
    netParity = parentParity ^ (ownOverlay ? 1 : 0);
    broadcastState();
  }

  /* ------------------------------------------------------------------ */
  /* 顶层页面                                                            */
  /* ------------------------------------------------------------------ */

  function evaluateTop(deep) {
    allow = settings.enabled && siteRule() !== 'off';

    if (!allow) {
      clearAll();
      broadcastState();
      return;
    }

    if (!document.body) return;

    const force = siteRule() === 'on' || settings.mode === 'always';
    const light = force || pageIsLight(deep);

    setOverlay(light, false);
    setMediaFilter(light);
    netParity = light ? 1 : 0;
    broadcastState();
  }

  function scheduleEvaluate(delay, deep) {
    if (deepTimer) clearTimeout(deepTimer);
    deepTimer = window.setTimeout(() => {
      if (IS_TOP) evaluateTop(deep);
      else evaluateFrame(deep);
    }, delay);
  }

  /* ------------------------------------------------------------------ */
  /* 提示条                                                              */
  /* ------------------------------------------------------------------ */

  function showToast(text) {
    if (!document.body) return;

    const previous = document.getElementById('__edm_toast');
    if (previous) previous.remove();

    const host = document.createElement('div');
    host.id = '__edm_toast';
    host.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:26px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity .18s ease, transform .18s ease'
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.textContent = text;
    box.style.cssText = [
      'font:13px/1.45 "Segoe UI","Microsoft YaHei",system-ui,sans-serif',
      'color:#f4f6f8',
      'background:#181c23',
      'border:1px solid rgba(255,255,255,.14)',
      'border-radius:999px',
      'padding:10px 17px',
      'box-shadow:0 10px 30px rgba(0,0,0,.5)',
      'white-space:nowrap'
    ].join(';');
    shadow.append(box);
    document.body.append(host);

    requestAnimationFrame(() => {
      host.style.opacity = '1';
      host.style.transform = 'translateX(-50%) translateY(-4px)';
    });

    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      host.style.opacity = '0';
      window.setTimeout(() => host.remove(), 220);
    }, 2400);
  }

  /* ------------------------------------------------------------------ */
  /* 站点开关（仅顶层）                                                  */
  /* ------------------------------------------------------------------ */

  function toggleSite() {
    const next = siteRule() === 'off' ? 'on' : 'off';
    const rules = { ...settings.siteRules };
    if (next === 'auto') delete rules[SITE_KEY];
    else rules[SITE_KEY] = next;

    settings = { ...settings, siteRules: rules };
    try {
      chrome.storage.local.set({ siteRules: rules });
    } catch {
      /* 存储暂不可用时，至少在当前页面立即生效。 */
    }

    evaluateTop(true);
    showToast(next === 'off' ? '本网站已关闭暗色模式' : '本网站已强制开启暗色模式');
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  function onBodyReady(callback) {
    if (!ROOT) return;
    if (document.body) {
      callback();
      return;
    }

    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      observer.disconnect();
      callback();
    };
    const observer = new MutationObserver(() => {
      if (document.body) fire();
    });
    observer.observe(ROOT, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', fire, { once: true });
  }

  function watchTheme() {
    const observer = new MutationObserver(() => {
      if (!allow) return;
      scheduleEvaluate(650, true);
    });

    if (ROOT) {
      observer.observe(ROOT, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'data-color-mode']
      });
    }

    onBodyReady(() => {
      if (document.body) {
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode']
        });
      }
    });
  }

  function bindTopSettings() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !ready) return;

        let structural = false;
        let touched = false;
        for (const key of Object.keys(DEFAULTS)) {
          if (!changes[key]) continue;
          touched = true;
          if (key === 'enabled' || key === 'mode' || key === 'siteRules') structural = true;
        }
        if (!touched) return;

        const next = { ...settings };
        for (const key of Object.keys(DEFAULTS)) {
          if (changes[key]) next[key] = changes[key].newValue;
        }
        settings = normalize(next);

        if (structural) evaluateTop(true);
        else if (allow) {
          if (ROOT && ROOT.getAttribute(ATTR) === '1') setVariables();
          broadcastState();
        }
      });
    } catch {
      /* 忽略 */
    }
  }

  function bindTopMessages() {
    try {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message !== 'object') return;

        if (message.type === 'EDM_TOGGLE_SITE') {
          toggleSite();
          sendResponse({ ok: true, rule: siteRule() });
          return;
        }

        if (message.type === 'EDM_GET_STATE') {
          sendResponse({
            ok: true,
            siteKey: SITE_KEY,
            host: location.hostname || (location.protocol === 'file:' ? '本地文件' : ''),
            active: Boolean(ROOT && ROOT.getAttribute(ATTR) === '1')
          });
        }
      });
    } catch {
      /* 忽略 */
    }
  }

  async function initTop() {
    installFrameMessaging();

    settings = await readSettings();
    ready = true;
    allow = settings.enabled && siteRule() !== 'off';

    if (!allow) {
      clearAll();
      broadcastState();
    } else if (siteRule() === 'on' || settings.mode === 'always') {
      setOverlay(true, false);
      setMediaFilter(true);
      netParity = 1;
      broadcastState();
    } else {
      onBodyReady(() => evaluateTop(true));
    }

    bindTopSettings();
    bindTopMessages();
    watchTheme();

    if (typeof media !== 'undefined' && media.addEventListener) {
      media.addEventListener('change', () => scheduleEvaluate(350, true));
    }

    window.addEventListener('load', () => {
      scheduleEvaluate(60, true);
      window.setTimeout(() => scheduleEvaluate(0, true), 1500);
    }, { once: true });

  }

  function initFrame() {
    installFrameMessaging();
    sayHello();
    window.setTimeout(sayHello, 400);
    window.setTimeout(sayHello, 1500);

    watchTheme();

    if (typeof media !== 'undefined' && media.addEventListener) {
      media.addEventListener('change', () => {
        if (allow) scheduleEvaluate(350, true);
      });
    }

    window.addEventListener('load', () => {
      if (!hasParentState) {
        sayHello();
        return;
      }
      if (allow) scheduleEvaluate(60, true);
    }, { once: true });
  }

  const media = window.matchMedia('(prefers-color-scheme: dark)');

  if (IS_TOP) initTop();
  else initFrame();
})();
