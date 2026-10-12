// pdf.js 4.x+/6.x распространяется как ES-модуль (.mjs)
import * as pdfjsLib from './pdf.mjs';
import {
  W, H, FOOTER, CH, LITTLEFS_BYTES,
  buildHeader, computeSliceStarts, percentileBounds,
  quantizeSlice, packCodes, estimate, pageBytes,
} from './pgb.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW:', e));
  });
}

const MAX_SCREENS = 6000; // как IMG_BOOK_MAX_PAGES в прошивке

const $ = (id) => document.getElementById(id);
const el = {
  pdfInput: $('pdfInput'), fileInfo: $('fileInfo'),
  autoCrop: $('autoCrop'), mode: $('mode'), threshold: $('threshold'), thresholdVal: $('thresholdVal'),
  useRed: $('useRed'),
  preview: $('preview'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'), previewInfo: $('previewInfo'),
  estimate: $('estimate'),
  btnConvert: $('btnConvert'), btnCancel: $('btnCancel'), progress: $('progress'), status: $('status'),
  ipInput: $('ipInput'), btnUpload: $('btnUpload'), btnDownload: $('btnDownload'),
  uploadForm: $('uploadForm'), hiddenFile: $('hiddenFile'),
};

let pdf = null;
let fileName = '';
let firstPage = { w: 595, h: 842 };
let crop = { l: 0, t: 0, r: 1, b: 1 };
let convertedBlob = null;
let cancelled = false;
let previewPage = 1;
let previewScreen = 0;
let previewToken = 0;

const work = document.createElement('canvas');

// ---------- настройки (запоминаем между запусками) ----------
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('pgb-settings') || '{}');
    if (s.mode) el.mode.value = s.mode;
    if (s.threshold) el.threshold.value = s.threshold;
    if (typeof s.autoCrop === 'boolean') el.autoCrop.checked = s.autoCrop;
    if (typeof s.useRed === 'boolean') el.useRed.checked = s.useRed;
    if (s.ip) el.ipInput.value = s.ip;
  } catch (_) { /* не критично */ }
  el.thresholdVal.textContent = el.threshold.value;
}
function saveSettings() {
  try {
    localStorage.setItem('pgb-settings', JSON.stringify({
      mode: el.mode.value, threshold: +el.threshold.value,
      autoCrop: el.autoCrop.checked, useRed: el.useRed.checked, ip: el.ipInput.value.trim(),
    }));
  } catch (_) { /* не критично */ }
}
function opts() {
  return {
    mode: el.mode.value,
    threshold: +el.threshold.value,
    useRed: el.useRed.checked,
    bpp: el.useRed.checked ? 2 : 1,
  };
}

// Один общий рабочий canvas -> рендеры выполняем строго по очереди
let chain = Promise.resolve();
function exclusive(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}
const renderSlices = (pageNum) => exclusive(() => renderSlicesRaw(pageNum));

// ---------- рендер одной PDF-страницы в набор «экранов» 400x280 ----------
async function renderSlicesRaw(pageNum) {
  const page = await pdf.getPage(pageNum);
  const v1 = page.getViewport({ scale: 1 });
  const cl = crop.l * v1.width, ct = crop.t * v1.height;
  const cw = (crop.r - crop.l) * v1.width, chPt = (crop.b - crop.t) * v1.height;
  const scale = W / cw;
  const hc = Math.max(1, Math.ceil(chPt * scale));

  work.width = W;      // смена размера очищает canvas
  work.height = hc;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, hc);

  const viewport = page.getViewport({ scale, offsetX: -cl * scale, offsetY: -ct * scale });
  await page.render({ canvasContext: ctx, canvas: work, viewport }).promise;

  const out = [];
  for (const s of computeSliceStarts(hc)) {
    const rows = Math.min(CH, hc - s);
    let rgba = ctx.getImageData(0, s, W, rows).data;
    if (rows < CH) {
      const full = new Uint8ClampedArray(W * CH * 4).fill(255);
      full.set(rgba);
      rgba = full;
    }
    out.push(rgba);
  }
  page.cleanup();
  return out;
}

// ---------- авто-обрезка полей по выборке страниц ----------
async function analyzeCrop() {
  if (!el.autoCrop.checked) { crop = { l: 0, t: 0, r: 1, b: 1 }; return; }
  const BINS = 200;
  const col = new Float64Array(BINS), row = new Float64Array(BINS);
  const n = pdf.numPages;
  const samples = Math.min(n, 20);
  const c = document.createElement('canvas');
  for (let k = 0; k < samples; k++) {
    const pn = samples === 1 ? 1 : 1 + Math.round((k * (n - 1)) / (samples - 1));
    const page = await pdf.getPage(pn);
    const v1 = page.getViewport({ scale: 1 });
    const sc = 300 / v1.width;
    const vp = page.getViewport({ scale: sc });
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const p = (y * c.width + x) * 4;
        if (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2] < 190) {
          col[Math.min(BINS - 1, Math.floor((x / c.width) * BINS))]++;
          row[Math.min(BINS - 1, Math.floor((y / c.height) * BINS))]++;
        }
      }
    }
    page.cleanup();
  }
  const [cl, cr] = percentileBounds(col, 0.003);
  const [ct, cb] = percentileBounds(row, 0.0005);
  let l = Math.max(0, cl / BINS - 0.012), r = Math.min(1, (cr + 1) / BINS + 0.012);
  let t = Math.max(0, ct / BINS - 0.01), b = Math.min(1, (cb + 1) / BINS + 0.01);
  if (r - l < 0.5) { const mid = (l + r) / 2; l = Math.max(0, mid - 0.25); r = Math.min(1, mid + 0.25); }
  if (b - t < 0.3) { t = 0; b = 1; }
  crop = { l, t, r, b };
}

// ---------- оценка размера ----------
function updateEstimate() {
  if (!pdf) { el.estimate.textContent = ''; return; }
  const bpp = opts().bpp;
  const e = estimate(firstPage.w, firstPage.h, crop, pdf.numPages, bpp);
  const mb = (e.bytes / 1048576).toFixed(1);
  const cap = (LITTLEFS_BYTES / 1048576).toFixed(1);
  let msg = `≈ ${e.perPage} экр. на страницу PDF, всего ≈ ${e.screens} экр., файл ≈ ${mb} МБ (доступно ≈ ${cap} МБ)`;
  el.estimate.className = 'estimate';
  if (e.screens > MAX_SCREENS) {
    msg += '\n⛔ Слишком много экранов (лимит прошивки ' + MAX_SCREENS + ').';
    el.estimate.className = 'estimate bad';
  } else if (e.bytes > LITTLEFS_BYTES) {
    msg += '\n⚠️ Не поместится во флеш ридера. Выключите «красный цвет», включите обрезку полей или конвертируйте часть книги.';
    el.estimate.className = 'estimate bad';
  } else if (e.bytes > LITTLEFS_BYTES * 0.9) {
    msg += '\n⚠️ Почти предел памяти ридера.';
    el.estimate.className = 'estimate warn';
  }
  el.estimate.textContent = msg;
}

// ---------- предпросмотр (ровно то, что увидит экран) ----------
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 150);
}
async function renderPreview() {
  if (!pdf) return;
  const token = ++previewToken;
  try {
    const slices = await renderSlices(previewPage);
    if (token !== previewToken) return;
    previewScreen = Math.max(0, Math.min(previewScreen, slices.length - 1));
    const o = opts();
    const codes = quantizeSlice(slices[previewScreen], o);
    const ctx = el.preview.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = 255; }
    for (let i = 0; i < W * CH; i++) {
      const c = codes[i]; if (!c) continue;
      const p = i * 4;
      if (c === 1) { d[p] = d[p + 1] = d[p + 2] = 0; } else { d[p] = 200; d[p + 1] = 0; d[p + 2] = 0; }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#e8e0d4'; ctx.fillRect(0, CH, W, FOOTER);
    ctx.fillStyle = '#8a7f72'; ctx.font = '12px sans-serif';
    ctx.fillText('футер ридера: стр. / WIFI / батарея', 10, CH + 14);
    el.previewInfo.textContent = `PDF стр. ${previewPage} из ${pdf.numPages}, экран ${previewScreen + 1} из ${slices.length}`;
    el.previewInfo.dataset.count = slices.length;
  } catch (e) {
    console.error(e);
    el.previewInfo.textContent = 'Ошибка предпросмотра: ' + e.message;
  }
}
el.nextBtn.addEventListener('click', () => {
  const cnt = +el.previewInfo.dataset.count || 1;
  if (previewScreen < cnt - 1) previewScreen++;
  else if (previewPage < pdf.numPages) { previewPage++; previewScreen = 0; }
  renderPreview();
});
el.prevBtn.addEventListener('click', () => {
  if (previewScreen > 0) previewScreen--;
  else if (previewPage > 1) { previewPage--; previewScreen = 9999; }
  renderPreview();
});

// ---------- загрузка PDF ----------
el.pdfInput.addEventListener('change', async () => {
  const f = el.pdfInput.files[0];
  convertedBlob = null;
  el.btnUpload.disabled = true; el.btnDownload.disabled = true; el.btnConvert.disabled = true;
  if (!f) return;
  fileName = f.name;
  el.fileInfo.textContent = 'Открываю PDF...';
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const p1 = await pdf.getPage(1);
    const v = p1.getViewport({ scale: 1 });
    firstPage = { w: v.width, h: v.height };
    p1.cleanup();
    el.fileInfo.textContent = `${fileName}: ${pdf.numPages} стр.`;
    el.fileInfo.textContent += '\nАнализирую поля...';
    await analyzeCrop();
    el.fileInfo.textContent = `${fileName}: ${pdf.numPages} стр.`;
    previewPage = 1; previewScreen = 0;
    updateEstimate();
    el.btnConvert.disabled = false;
    renderPreview();
  } catch (e) {
    console.error(e);
    pdf = null;
    el.fileInfo.textContent = 'Не удалось открыть PDF: ' + e.message;
  }
});

// ---------- реакция на изменение настроек ----------
async function onSettingsChanged(recropNeeded) {
  saveSettings();
  el.thresholdVal.textContent = el.threshold.value;
  if (!pdf) return;
  convertedBlob = null;
  el.btnUpload.disabled = true; el.btnDownload.disabled = true;
  if (recropNeeded) await analyzeCrop();
  updateEstimate();
  schedulePreview();
}
el.autoCrop.addEventListener('change', () => onSettingsChanged(true));
el.mode.addEventListener('change', () => onSettingsChanged(false));
el.threshold.addEventListener('input', () => onSettingsChanged(false));
el.useRed.addEventListener('change', () => onSettingsChanged(false));
el.ipInput.addEventListener('change', saveSettings);

// ---------- конвертация ----------
function setLocked(v) {
  for (const k of ['pdfInput', 'autoCrop', 'mode', 'threshold', 'useRed', 'prevBtn', 'nextBtn']) el[k].disabled = v;
}
el.btnCancel.addEventListener('click', () => { cancelled = true; });
el.btnConvert.addEventListener('click', async () => {
  if (!pdf) return;
  const o = opts();
  cancelled = false;
  convertedBlob = null;
  setLocked(true);
  el.btnConvert.disabled = true; el.btnCancel.style.display = 'block';
  el.btnUpload.disabled = true; el.btnDownload.disabled = true;
  el.progress.style.display = 'block';
  el.progress.max = pdf.numPages; el.progress.value = 0;

  const chunks = [];
  let screens = 0;
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      if (cancelled) throw new Error('Отменено');
      const slices = await renderSlices(p);
      for (const rgba of slices) {
        chunks.push(packCodes(quantizeSlice(rgba, o), o.bpp));
        screens++;
      }
      if (screens > MAX_SCREENS) throw new Error('Больше ' + MAX_SCREENS + ' экранов — прошивка столько не принимает');
      el.progress.value = p;
      el.status.textContent = `Конвертация: страница ${p} из ${pdf.numPages} (экранов: ${screens})`;
      await new Promise((r) => setTimeout(r, 0)); // дать интерфейсу вздохнуть
    }
    convertedBlob = new Blob([buildHeader(screens, o.bpp), ...chunks], { type: 'application/octet-stream' });
    const mb = (convertedBlob.size / 1048576).toFixed(1);
    let msg = `Готово: ${screens} экранов, ${mb} МБ`;
    if (convertedBlob.size > LITTLEFS_BYTES) msg += '\n⚠️ Файл больше памяти ридера — загрузка не удастся.';
    el.status.textContent = msg;
    el.btnUpload.disabled = false; el.btnDownload.disabled = false;
  } catch (e) {
    console.error(e);
    el.status.textContent = 'Ошибка: ' + e.message;
  } finally {
    setLocked(false);
    el.btnConvert.disabled = false; el.btnCancel.style.display = 'none';
  }
});

// ---------- скачать файл (запасной путь: потом загрузить через страницу ридера http://IP/) ----------
el.btnDownload.addEventListener('click', () => {
  if (!convertedBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(convertedBlob);
  a.download = (fileName.replace(/\.pdf$/i, '') || 'book') + '.pgb';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
});

// ---------- загрузка на ридер ----------
// ВАЖНО: обработчик СИНХРОННЫЙ (без await до submit) — иначе браузер может счесть
// открытие новой вкладки не следствием клика и заблокировать её как всплывающее окно.
// Это обычная HTML-форма (не fetch): fetch с https-страницы на http-адрес браузер блокирует,
// а отправка формы допускается (с предупреждением «форма не защищена»).
el.btnUpload.addEventListener('click', () => {
  if (!convertedBlob) return;
  let ip = (el.ipInput.value || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!ip) ip = '192.168.4.1';
  saveSettings();
  const file = new File([convertedBlob], 'book.pgb', { type: 'application/octet-stream' });
  const dt = new DataTransfer();
  dt.items.add(file);
  el.hiddenFile.files = dt.files;
  el.uploadForm.action = `http://${ip}/upload`;
  el.uploadForm.submit();
  el.status.textContent = 'Загрузка открыта в новой вкладке. Если браузер спросил подтверждение — согласитесь. Дождитесь «Книга загружена».';
});

loadSettings();
