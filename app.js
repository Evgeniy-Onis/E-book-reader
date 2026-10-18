// pdf.js 4.x+/6.x распространяется как ES-модуль (.mjs)
import * as pdfjsLib from './pdf.mjs';
import {
  W, H, FOOTER, CH, OVERLAP, LITTLEFS_BYTES,
  assemblePgb, computeStarts, percentileBounds, quantizeSlice, packCodes, hasRed, estimate,
} from './pgb.js';
import { extractParagraphs, buildFb2, detectTextLayer, estimateTextScreens } from './pdftext.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW:', e));
  });
}

const MAX_SCREENS = 6000;      // IMG_BOOK_MAX_PAGES в прошивке (.pgb)
const MAX_TEXT_PAGES = 1200;   // MAX_PAGES в прошивке (текстовые книги)

const $ = (id) => document.getElementById(id);
const ids = ['fileInput','fileInfo','pdfCard','radText','radImg','recommend','rangeFrom','rangeTo','textOptions','removeHeaders','dehyphenate',
  'textStats','textPreview','imgOptions','layout','zoomField','zoom','autoCrop','mode','threshold','thresholdVal','useRed','preview','prevBtn','nextBtn',
  'previewInfo','estimate','convertCard','btnConvert','btnCancel','progress','status','ipInput','readyInfo','btnUpload','btnDownload',
  'btnStatus','devStatus','gotoInput','btnGoto','btnDelete','openPanel','uploadForm','hiddenFile'];
const el = Object.fromEntries(ids.map((i) => [i, $(i)]));
const tick = () => new Promise((r) => setTimeout(r, 0));
const mb = (b) => (b / 1048576).toFixed(1);
// «x is not a function» внутри pdf.js = браузер не знает новых функций JS; лечится «legacy»-сборкой pdf.js
const explain = (e) => (/is not a function|is not defined/.test(e.message || '')
  ? e.message + '\nПохоже, браузер слишком старый для этой сборки pdf.js: возьмите файлы pdf.mjs и pdf.worker.mjs из папки legacy/build.'
  : e.message);

// ---------- состояние ----------
let src = { kind: null, file: null };     // kind: pdf | epub | fb2 | pgb
let pdf = null;
let baseName = 'book';
let textCache = [];                       // textCache[n] = { n, w, h, items }
let textLayer = { text: false, ratio: 0, avg: 0 };
let textResult = null;                    // { paragraphs, stats }
let firstPage = { w: 595, h: 842 };
let crop = { l: 0, t: 0, r: 1, b: 1 };
let cropReady = false;
let result = null;                        // { blob, name }  — то, что уйдёт на ридер
let cancelled = false;
let previewPage = 1, previewScreen = 0, previewToken = 0;
let devInfo = null;
const work = document.createElement('canvas');

// ---------- настройки ----------
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('pgb-settings2') || '{}');
    for (const k of ['mode', 'layout', 'zoom']) if (s[k]) el[k].value = s[k];
    if (s.threshold) el.threshold.value = s.threshold;
    for (const k of ['autoCrop', 'useRed', 'removeHeaders', 'dehyphenate']) if (typeof s[k] === 'boolean') el[k].checked = s[k];
    if (s.ip) el.ipInput.value = s.ip;
  } catch (_) { /* не критично */ }
  el.thresholdVal.textContent = el.threshold.value;
  updatePanelLink();
}
function saveSettings() {
  try {
    localStorage.setItem('pgb-settings2', JSON.stringify({
      mode: el.mode.value, layout: el.layout.value, zoom: el.zoom.value, threshold: +el.threshold.value,
      autoCrop: el.autoCrop.checked, useRed: el.useRed.checked, removeHeaders: el.removeHeaders.checked,
      dehyphenate: el.dehyphenate.checked, ip: el.ipInput.value.trim(),
    }));
  } catch (_) { /* не критично */ }
}
const outMode = () => (document.querySelector('input[name=outMode]:checked') || {}).value || 'img';
const getLayout = () => ({ mode: el.layout.value, zoom: el.layout.value === 'page' ? 1 : +el.zoom.value });
const imgOpts = () => ({ mode: el.mode.value, threshold: +el.threshold.value, useRed: el.useRed.checked });
function getRange() {
  const n = pdf ? pdf.numPages : 1;
  let a = Math.max(1, Math.min(n, parseInt(el.rangeFrom.value, 10) || 1));
  let b = Math.max(1, Math.min(n, parseInt(el.rangeTo.value, 10) || n));
  if (b < a) [a, b] = [b, a];
  return [a, b];
}
function devHost() {
  let ip = (el.ipInput.value || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return ip || '192.168.4.1';
}
function updatePanelLink() { el.openPanel.href = `http://${devHost()}/`; }

function setResult(r) {
  result = r;
  el.btnUpload.disabled = !r;
  el.btnDownload.disabled = !r;
  if (!r) { el.readyInfo.textContent = ''; el.readyInfo.className = 'info'; return; }
  let msg = `Готово к загрузке: ${r.name} (${r.blob.size >= 1048576 ? mb(r.blob.size) + ' МБ' : Math.max(1, Math.round(r.blob.size / 1024)) + ' КБ'})`;
  let cls = 'info ok';
  if (devInfo) {
    const avail = devInfo.fs_total - devInfo.fs_used + (devInfo.book_size || 0);
    if (r.blob.size > avail * 0.97) { msg += `\n⚠️ По последнему статусу на ридере свободно ≈ ${mb(avail)} МБ — файл не поместится.`; cls = 'info bad'; }
  } else if (r.blob.size > LITTLEFS_BYTES) { msg += '\n⚠️ Файл больше памяти ридера (≈ 12.9 МБ).'; cls = 'info bad'; }
  el.readyInfo.textContent = msg;
  el.readyInfo.className = cls;
}

// =====================================================================
//  Выбор файла
// =====================================================================
el.fileInput.addEventListener('change', async () => {
  const f = el.fileInput.files[0];
  setResult(null);
  pdf = null; textCache = []; textResult = null; cropReady = false;
  el.pdfCard.classList.add('hidden'); el.convertCard.classList.add('hidden');
  if (!f) { el.fileInfo.textContent = ''; return; }
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  baseName = f.name.replace(/\.[^.]+$/, '') || 'book';
  src = { kind: ext, file: f };

  if (ext === 'pdf') { await openPdf(f); return; }

  if (['epub', 'fb2', 'pgb'].includes(ext)) {
    let note = '';
    if (ext === 'pgb') {
      const head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
      const ok = String.fromCharCode(...head.slice(0, 4)) === 'PGB1';
      if (!ok) { el.fileInfo.textContent = 'Это не файл .pgb (нет сигнатуры PGB1).'; return; }
      if (head[4] !== 2) note = '\n⚠️ Файл старого формата — пересоздайте его из PDF в этом приложении.';
    }
    el.fileInfo.textContent = `${f.name}: конвертация не нужна, файл можно сразу отправить на ридер.${note}`;
    setResult({ blob: f, name: f.name });
    return;
  }
  el.fileInfo.textContent = 'Поддерживаются файлы PDF, EPUB, FB2 и PGB.';
});

// =====================================================================
//  PDF: открытие, текстовый слой
// =====================================================================
async function openPdf(f) {
  el.fileInfo.textContent = 'Открываю PDF...';
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const p1 = await pdf.getPage(1);
    const v = p1.getViewport({ scale: 1 });
    firstPage = { w: v.width, h: v.height };
    p1.cleanup();

    el.rangeFrom.value = 1; el.rangeTo.value = pdf.numPages;
    el.rangeFrom.max = el.rangeTo.max = pdf.numPages;
    el.pdfCard.classList.remove('hidden'); el.convertCard.classList.remove('hidden');
    el.btnConvert.disabled = true;

    const counts = await extractAllText();
    textLayer = detectTextLayer(counts);
    const pct = Math.round(textLayer.ratio * 100);
    el.fileInfo.textContent = `${f.name}: ${pdf.numPages} стр.`;
    if (textLayer.text) {
      el.recommend.textContent = `✅ В PDF есть текстовый слой (текст найден на ${pct}% страниц) — рекомендуем режим «Текст»: шрифт ридера крупнее и читается лучше.`;
      el.recommend.className = 'info ok';
      document.querySelector('input[name=outMode][value=text]').checked = true;
    } else {
      el.recommend.textContent = `ℹ️ Текстового слоя почти нет (текст найден на ${pct}% страниц) — вероятно, это скан или графика. Рекомендуем «Картинки страниц».`;
      el.recommend.className = 'info warn';
      document.querySelector('input[name=outMode][value=img]').checked = true;
    }
    await applyMode();
    el.btnConvert.disabled = false;
  } catch (e) {
    console.error(e);
    pdf = null;
    el.fileInfo.textContent = 'Не удалось открыть PDF: ' + explain(e);
  }
}

async function extractAllText() {
  const n = pdf.numPages;
  textCache = new Array(n + 1);
  const counts = [];
  for (let p = 1; p <= n; p++) {
    const page = await pdf.getPage(p);
    const v = page.getViewport({ scale: 1 });
    const [vx0, vy0] = page.view;
    const tc = await page.getTextContent();
    const items = [];
    let chars = 0;
    for (const it of tc.items) {
      if (!('str' in it) || !it.str) continue;
      items.push({ str: it.str, x: it.transform[4] - vx0, y: it.transform[5] - vy0,
                   h: Math.hypot(it.transform[2], it.transform[3]) || it.height || 10, w: it.width });
      chars += it.str.trim().length;
    }
    textCache[p] = { n: p, w: v.width, h: v.height, items };
    counts.push(chars);
    page.cleanup();
    if (p % 4 === 0) { el.fileInfo.textContent = `Анализ текста: страница ${p} из ${n}`; await tick(); }
  }
  return counts;
}

// =====================================================================
//  Переключение режимов
// =====================================================================
async function applyMode() {
  const m = outMode();
  el.radText.classList.toggle('sel', m === 'text');
  el.radImg.classList.toggle('sel', m === 'img');
  el.textOptions.classList.toggle('hidden', m !== 'text');
  el.imgOptions.classList.toggle('hidden', m !== 'img');
  el.zoomField.classList.toggle('hidden', el.layout.value === 'page');
  setResult(null);
  el.status.textContent = '';
  if (!pdf) return;
  if (m === 'text') rebuildText();
  else { await ensureCrop(); updateEstimate(); previewPage = getRange()[0]; previewScreen = 0; schedulePreview(); }
}
document.querySelectorAll('input[name=outMode]').forEach((r) => r.addEventListener('change', applyMode));

let settingsTimer = null;
function onSettings(recrop) {
  saveSettings();
  el.thresholdVal.textContent = el.threshold.value;
  el.zoomField.classList.toggle('hidden', el.layout.value === 'page');
  if (!pdf) return;
  setResult(null);
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    if (outMode() === 'text') { rebuildText(); return; }
    if (recrop) { cropReady = false; await ensureCrop(); }
    updateEstimate(); schedulePreview();
  }, 150);
}
for (const k of ['removeHeaders', 'dehyphenate']) el[k].addEventListener('change', () => onSettings(false));
for (const k of ['layout', 'zoom', 'mode', 'useRed']) el[k].addEventListener('change', () => onSettings(false));
el.autoCrop.addEventListener('change', () => onSettings(true));
el.threshold.addEventListener('input', () => onSettings(false));
for (const k of ['rangeFrom', 'rangeTo']) el[k].addEventListener('change', () => { cropReady = false; onSettings(true); });
el.ipInput.addEventListener('change', () => { saveSettings(); updatePanelLink(); });

// =====================================================================
//  Режим «Текст» (FB2)
// =====================================================================
function rebuildText() {
  const [a, b] = getRange();
  const pages = [];
  for (let p = a; p <= b; p++) if (textCache[p] && textCache[p].items.length) pages.push(textCache[p]);
  textResult = extractParagraphs(pages, { removeHeaders: el.removeHeaders.checked, dehyphenate: el.dehyphenate.checked });
  const st = textResult.stats;
  const screens = estimateTextScreens(textResult.paragraphs);
  const skipped = (b - a + 1) - st.pagesWithText;
  let msg = `Страниц PDF: ${b - a + 1}, с текстом: ${st.pagesWithText}. Символов: ${st.chars}. ≈ ${screens} экранов на ридере.`;
  el.textStats.className = 'info';
  if (skipped > 0) { msg += `\n⚠️ ${skipped} стр. без текста (картинки/сканы) будут пропущены.`; el.textStats.className = 'info warn'; }
  if (screens > MAX_TEXT_PAGES) { msg += `\n⛔ Больше лимита прошивки (${MAX_TEXT_PAGES} экранов) — лишнее будет обрезано. Укажите диапазон страниц и загрузите книгу частями.`; el.textStats.className = 'info bad'; }
  if (!st.chars) { msg = 'В выбранных страницах нет текста — используйте режим «Картинки страниц».'; el.textStats.className = 'info bad'; }
  el.textStats.textContent = msg;
  const prev = textResult.paragraphs.slice(0, 40).map((p) => (p.type === 'h' ? '# ' : '    ') + p.text).join('\n\n');
  el.textPreview.textContent = prev.slice(0, 2500) || '(пусто)';
}

// =====================================================================
//  Режим «Картинки»
// =====================================================================
let chain = Promise.resolve();
function exclusive(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }
const renderSlices = (n) => exclusive(() => renderSlicesRaw(n));

async function renderSlicesRaw(pageNum) {
  const lay = getLayout();
  const page = await pdf.getPage(pageNum);
  const v1 = page.getViewport({ scale: 1 });
  const cl = crop.l * v1.width, ct = crop.t * v1.height;
  const cw = (crop.r - crop.l) * v1.width, chPt = (crop.b - crop.t) * v1.height;

  let scale, cwPx, hcPx, offX, offY, ys, xs;
  if (lay.mode === 'page') {          // страница целиком на одном экране
    scale = Math.min(W / cw, CH / chPt);
    cwPx = W; hcPx = CH;
    offX = -cl * scale + (W - cw * scale) / 2;
    offY = -ct * scale + (CH - chPt * scale) / 2;
    ys = [0]; xs = [0];
  } else {                             // по ширине текста (+ увеличение)
    scale = (W * lay.zoom) / cw;
    cwPx = Math.round(W * lay.zoom);
    hcPx = Math.max(1, Math.ceil(chPt * scale));
    offX = -cl * scale; offY = -ct * scale;
    ys = computeStarts(hcPx, CH, OVERLAP);
    xs = computeStarts(cwPx, W, OVERLAP);
  }

  work.width = cwPx; work.height = hcPx;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cwPx, hcPx);
  const viewport = page.getViewport({ scale, offsetX: offX, offsetY: offY });
  await page.render({ canvasContext: ctx, canvas: work, viewport }).promise;

  const out = [];
  for (const y of ys) for (const x of xs) {
    const rows = Math.min(CH, hcPx - y), cols = Math.min(W, cwPx - x);
    const data = ctx.getImageData(x, y, cols, rows).data;
    if (rows === CH && cols === W) { out.push(data); continue; }
    const full = new Uint8ClampedArray(W * CH * 4).fill(255);
    for (let r = 0; r < rows; r++) full.set(data.subarray(r * cols * 4, (r + 1) * cols * 4), r * W * 4);
    out.push(full);
  }
  page.cleanup();
  return out;
}

async function ensureCrop() {
  if (cropReady) return;
  if (!el.autoCrop.checked) { crop = { l: 0, t: 0, r: 1, b: 1 }; cropReady = true; return; }
  el.previewInfo.textContent = 'Анализирую поля...';
  const BINS = 200, col = new Float64Array(BINS), row = new Float64Array(BINS);
  const [a, b] = getRange();
  const n = b - a + 1, samples = Math.min(n, 20);
  const c = document.createElement('canvas');
  for (let k = 0; k < samples; k++) {
    const pn = a + (samples === 1 ? 0 : Math.round((k * (n - 1)) / (samples - 1)));
    const page = await pdf.getPage(pn);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 300 / v1.width });
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await exclusive(() => page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const p = (y * c.width + x) * 4;
      if (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2] < 190) {
        col[Math.min(BINS - 1, Math.floor((x / c.width) * BINS))]++;
        row[Math.min(BINS - 1, Math.floor((y / c.height) * BINS))]++;
      }
    }
    page.cleanup();
  }
  const [cl, cr] = percentileBounds(col, 0.003);
  const [ct, cb] = percentileBounds(row, 0.0005);
  let l = Math.max(0, cl / BINS - 0.012), r = Math.min(1, (cr + 1) / BINS + 0.012);
  let t = Math.max(0, ct / BINS - 0.01), bt = Math.min(1, (cb + 1) / BINS + 0.01);
  if (r - l < 0.5) { const mid = (l + r) / 2; l = Math.max(0, mid - 0.25); r = Math.min(1, mid + 0.25); }
  if (bt - t < 0.3) { t = 0; bt = 1; }
  crop = { l, t, r, b: bt };
  cropReady = true;
}

function updateEstimate() {
  if (!pdf) return;
  const [a, b] = getRange();
  const o = imgOpts();
  const e = estimate(firstPage.w, firstPage.h, crop, b - a + 1, getLayout());
  const cap = LITTLEFS_BYTES;
  // «фото ч/б» и «только текст» без красного — всегда 1 бит; иначе размер зависит от числа цветных экранов
  const oneBitOnly = o.mode === 'photo' || (o.mode === 'text' && !o.useRed);
  let msg = `≈ ${e.perPage} экр. на страницу PDF, всего ≈ ${e.screens} экр.\n`;
  msg += oneBitOnly
    ? `Файл ≈ ${mb(e.bytes)} МБ (доступно ≈ ${mb(cap)} МБ)`
    : `Файл от ${mb(e.bytes)} МБ (если всё чёрно-белое) до ${mb(e.bytesMax)} МБ (если всё цветное); цветные экраны занимают вдвое больше. Доступно ≈ ${mb(cap)} МБ`;
  el.estimate.className = 'estimate';
  if (e.screens > MAX_SCREENS) { msg += `\n⛔ Больше лимита прошивки (${MAX_SCREENS} экранов).`; el.estimate.className = 'estimate bad'; }
  else if (e.bytes > cap) { msg += '\n⛔ Не поместится во флеш ридера даже без цвета. Уменьшите увеличение, выберите «Страница целиком» или загрузите часть книги (диапазон страниц).'; el.estimate.className = 'estimate bad'; }
  else if (!oneBitOnly && e.bytesMax > cap) { msg += '\n⚠️ Если в книге много цветных страниц, файл может не поместиться — итоговый размер будет известен после конвертации.'; el.estimate.className = 'estimate warn'; }
  else if (e.bytes > cap * 0.9) { msg += '\n⚠️ Почти предел памяти ридера.'; el.estimate.className = 'estimate warn'; }
  el.estimate.textContent = msg;
}

let previewTimer = null;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 150); }
async function renderPreview() {
  if (!pdf || outMode() !== 'img') return;
  const [a, b] = getRange();
  previewPage = Math.max(a, Math.min(b, previewPage));
  const token = ++previewToken;
  try {
    await ensureCrop();
    const slices = await renderSlices(previewPage);
    if (token !== previewToken) return;
    previewScreen = Math.max(0, Math.min(previewScreen, slices.length - 1));
    const codes = quantizeSlice(slices[previewScreen], imgOpts());
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
    el.previewInfo.textContent = 'Ошибка предпросмотра: ' + explain(e);
  }
}
el.nextBtn.addEventListener('click', () => {
  const [, b] = getRange();
  const cnt = +el.previewInfo.dataset.count || 1;
  if (previewScreen < cnt - 1) previewScreen++;
  else if (previewPage < b) { previewPage++; previewScreen = 0; }
  renderPreview();
});
el.prevBtn.addEventListener('click', () => {
  const [a] = getRange();
  if (previewScreen > 0) previewScreen--;
  else if (previewPage > a) { previewPage--; previewScreen = 9999; }
  renderPreview();
});

// =====================================================================
//  Конвертация
// =====================================================================
function setLocked(v) {
  for (const k of ['fileInput', 'rangeFrom', 'rangeTo', 'removeHeaders', 'dehyphenate', 'layout', 'zoom', 'autoCrop', 'mode', 'threshold', 'useRed', 'prevBtn', 'nextBtn'])
    el[k].disabled = v;
  document.querySelectorAll('input[name=outMode]').forEach((r) => (r.disabled = v));
}
el.btnCancel.addEventListener('click', () => { cancelled = true; });
el.btnConvert.addEventListener('click', async () => {
  if (!pdf) return;
  setResult(null);
  if (outMode() === 'text') { convertText(); return; }
  await convertImages();
});

function convertText() {
  rebuildText();
  if (!textResult.stats.chars) { el.status.textContent = 'Нет текста для конвертации.'; return; }
  const fb2 = buildFb2(baseName, textResult.paragraphs);
  const blob = new Blob([fb2], { type: 'application/x-fictionbook+xml' });
  el.status.textContent = `Готово: FB2, ${textResult.paragraphs.length} абзацев.`;
  setResult({ blob, name: baseName.replace(/[^\p{L}\p{N}._ -]/gu, '_') + '.fb2' });
}

async function convertImages() {
  const o = imgOpts();
  const [a, b] = getRange();
  cancelled = false;
  setLocked(true);
  el.btnConvert.disabled = true; el.btnCancel.classList.remove('hidden');
  el.progress.style.display = 'block'; el.progress.max = b - a + 1; el.progress.value = 0;
  const pages = [];
  let screens = 0, colorScreens = 0;
  try {
    await ensureCrop();
    for (let p = a; p <= b; p++) {
      if (cancelled) throw new Error('Отменено');
      for (const rgba of await renderSlices(p)) {
        const codes = quantizeSlice(rgba, o);
        const bpp = hasRed(codes) ? 2 : 1;      // 2 бита только там, где реально есть красный
        if (bpp === 2) colorScreens++;
        pages.push({ bpp, data: packCodes(codes, bpp) });
        screens++;
      }
      if (screens > MAX_SCREENS) throw new Error('Больше ' + MAX_SCREENS + ' экранов — прошивка столько не принимает');
      el.progress.value = p - a + 1;
      el.status.textContent = `Конвертация: страница ${p - a + 1} из ${b - a + 1} (экранов: ${screens})`;
      await tick();
    }
    const blob = new Blob(assemblePgb(pages), { type: 'application/octet-stream' });
    el.status.textContent = `Готово: ${screens} экранов (из них цветных: ${colorScreens}), ${mb(blob.size)} МБ`;
    setResult({ blob, name: baseName.replace(/[^\p{L}\p{N}._ -]/gu, '_') + '.pgb' });
  } catch (e) {
    console.error(e);
    el.status.textContent = 'Ошибка: ' + explain(e);
  } finally {
    setLocked(false);
    el.btnConvert.disabled = false; el.btnCancel.classList.add('hidden');
  }
}

// =====================================================================
//  Скачать / загрузить на ридер
// =====================================================================
el.btnDownload.addEventListener('click', () => {
  if (!result) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(result.blob);
  a.download = result.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
});

// ВАЖНО: обработчик СИНХРОННЫЙ (без await до submit) — иначе браузер может счесть открытие
// новой вкладки не следствием клика и заблокировать её как всплывающее окно.
// Это обычная HTML-форма (не fetch): fetch с https-страницы на http-адрес браузер блокирует,
// а отправка формы допускается (с предупреждением «форма не защищена»).
el.btnUpload.addEventListener('click', () => {
  if (!result) return;
  if (result.blob.size === 0) { el.readyInfo.textContent = 'Файл пустой — повторите подготовку.'; return; }
  if (devInfo) {
    const avail = devInfo.fs_total - devInfo.fs_used + (devInfo.book_size || 0);
    if (result.blob.size > avail * 0.97 && !confirm(`На ридере свободно ≈ ${mb(avail)} МБ, а файл ${mb(result.blob.size)} МБ. Всё равно отправить?`)) return;
  }
  saveSettings();
  const file = new File([result.blob], result.name, { type: 'application/octet-stream' });
  const dt = new DataTransfer();
  dt.items.add(file);
  el.hiddenFile.files = dt.files;
  el.uploadForm.action = `http://${devHost()}/upload`;
  el.uploadForm.submit();
  el.readyInfo.textContent = 'Загрузка открыта в новой вкладке. Если браузер спросил подтверждение — согласитесь и дождитесь «Книга загружена».';
  el.readyInfo.className = 'info';
});

// =====================================================================
//  Панель ридера (best effort: зависит от разрешений браузера)
// =====================================================================
async function devFetch(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`http://${devHost()}${path}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
function showDevError() {
  el.devStatus.className = 'info warn';
  el.devStatus.textContent = 'Нет связи с ридером из приложения. Проверьте, что телефон подключён к Wi-Fi ридера, и разрешите браузеру доступ к локальной сети. Если не помогает — откройте страницу ридера по ссылке ниже.';
}
async function refreshStatus() {
  el.devStatus.className = 'info'; el.devStatus.textContent = 'Запрашиваю статус...';
  try {
    const s = await devFetch('/api/status');
    devInfo = s;
    const free = s.fs_total - s.fs_used;
    el.devStatus.className = 'info ok';
    el.devStatus.textContent =
      `Книга: ${s.book || '—'} (${s.type})\n` +
      `Страница: ${s.page} из ${s.pages}\n` +
      `Батарея: ${s.batt_pct}% (${s.batt_v} В)\n` +
      `Хранилище книг: занято ${mb(s.fs_used)} из ${mb(s.fs_total)} МБ, свободно ${mb(free)} МБ\n` +
      `PSRAM: ${Math.round(s.psram_free / 1024)} / ${Math.round(s.psram_total / 1024)} КБ\n` +
      `DRAM: ${Math.round(s.dram_free / 1024)} / ${Math.round(s.dram_total / 1024)} КБ`;
    if (s.pages) el.gotoInput.max = s.pages;
    if (result) setResult(result);
  } catch (e) { console.warn(e); showDevError(); }
}
el.btnStatus.addEventListener('click', refreshStatus);
el.btnGoto.addEventListener('click', async () => {
  const p = parseInt(el.gotoInput.value, 10);
  if (!p) return;
  try { await devFetch('/api/goto?page=' + p); await refreshStatus(); } catch (e) { showDevError(); }
});
el.btnDelete.addEventListener('click', async () => {
  if (!confirm('Удалить текущую книгу с ридера?')) return;
  try { await devFetch('/api/delete?confirm=1'); devInfo = null; await refreshStatus(); } catch (e) { showDevError(); }
});

loadSettings();
