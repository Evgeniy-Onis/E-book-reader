// Должно совпадать с SCREEN_WIDTH / SCREEN_HEIGHT в прошивке (main.cpp)
const TARGET_W = 400;
const TARGET_H = 300;

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => {
      console.warn('SW registration failed', e);
    });
  });
}

let convertedBlob = null;
let selectedFile = null;

const pdfInput = document.getElementById('pdfInput');
const btnConvert = document.getElementById('btnConvert');
const btnUpload = document.getElementById('btnUpload');
const progressBar = document.getElementById('progressBar');
const statusText = document.getElementById('statusText');
const ipInput = document.getElementById('ipInput');
const uploadForm = document.getElementById('uploadForm');
const hiddenFileInput = document.getElementById('hiddenFileInput');

pdfInput.addEventListener('change', () => {
  selectedFile = pdfInput.files[0] || null;
  btnConvert.disabled = !selectedFile;
  btnUpload.disabled = true;
  convertedBlob = null;
  statusText.textContent = selectedFile ? `Выбран: ${selectedFile.name}` : '';
});

btnConvert.addEventListener('click', async () => {
  if (!selectedFile) return;
  btnConvert.disabled = true;
  progressBar.style.display = 'block';
  progressBar.value = 0;
  statusText.textContent = 'Открываю PDF...';

  try {
    await convertPdf(selectedFile, (cur, total) => {
      progressBar.max = total;
      progressBar.value = cur;
      statusText.textContent = `Конвертация: страница ${cur} из ${total}`;
    });
    statusText.textContent = `Готово: ${(convertedBlob.size / 1024).toFixed(0)} КБ`;
    btnUpload.disabled = false;
  } catch (e) {
    console.error(e);
    statusText.textContent = 'Ошибка конвертации: ' + e.message;
  } finally {
    btnConvert.disabled = false;
  }
});

// ВАЖНО: этот обработчик должен остаться СИНХРОННЫМ (без await) до самого
// submit() — иначе браузер может посчитать открытие новой вкладки не прямым
// следствием клика пользователя и заблокировать его как всплывающее окно.
btnUpload.addEventListener('click', () => {
  if (!convertedBlob) return;
  const ip = (ipInput.value || '').trim() || '192.168.4.1';

  const file = new File([convertedBlob], 'book.pgb', { type: 'application/octet-stream' });
  const dt = new DataTransfer();
  dt.items.add(file);
  hiddenFileInput.files = dt.files;

  uploadForm.action = `http://${ip}/upload`;
  uploadForm.submit();

  statusText.textContent = 'Открыл загрузку в новой вкладке — подтвердите, если браузер спросит.';
});

async function convertPdf(file, onProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pageCount = pdf.numPages;
  if (pageCount <= 0) throw new Error('В PDF нет страниц');

  const chunks = [buildHeader(pageCount)];

  const canvas = document.createElement('canvas');
  canvas.width = TARGET_W;
  canvas.height = TARGET_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const unscaled = page.getViewport({ scale: 1 });
    const scale = Math.min(TARGET_W / unscaled.width, TARGET_H / unscaled.height);
    const viewport = page.getViewport({ scale });

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, TARGET_W, TARGET_H);
    const offsetX = Math.round((TARGET_W - viewport.width) / 2);
    const offsetY = Math.round((TARGET_H - viewport.height) / 2);
    ctx.translate(offsetX, offsetY);

    await page.render({ canvasContext: ctx, viewport }).promise;

    const imageData = ctx.getImageData(0, 0, TARGET_W, TARGET_H);
    chunks.push(ditherAndPack(imageData));

    onProgress(i, pageCount);
  }

  convertedBlob = new Blob(chunks, { type: 'application/octet-stream' });
  return convertedBlob;
}

function buildHeader(pageCount) {
  const h = new Uint8Array(16);
  h[0] = 0x50; h[1] = 0x47; h[2] = 0x42; h[3] = 0x31; // "PGB1"
  h[4] = 1; // версия
  h[5] = TARGET_W & 0xFF;
  h[6] = (TARGET_W >> 8) & 0xFF;
  h[7] = TARGET_H & 0xFF;
  h[8] = (TARGET_H >> 8) & 0xFF;
  h[9] = pageCount & 0xFF;
  h[10] = (pageCount >> 8) & 0xFF;
  h[11] = (pageCount >> 16) & 0xFF;
  h[12] = (pageCount >> 24) & 0xFF;
  // h[13..15] = 0 (резерв)
  return h;
}

// Дизеринг Флойда-Стейнберга (ч/б) + простое обнаружение красного.
// Упаковка 2 бита/пиксель: 00=белый, 01=чёрный, 10=красный.
// Порядок бит в байте ДОЛЖЕН совпадать с прошивкой (shift = 6 - 2*(x%4)).
function ditherAndPack(imageData) {
  const w = TARGET_W, h = TARGET_H;
  const px = imageData.data; // Uint8ClampedArray RGBA
  const gray = new Float32Array(w * h);
  const isRed = new Uint8Array(w * h);

  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const r = px[p], g = px[p + 1], b = px[p + 2];
    isRed[i] = (r > g + 40 && r > b + 40 && r > 100) ? 1 : 0;
    gray[i] = isRed[i] ? 255 : (0.299 * r + 0.587 * g + 0.114 * b);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (isRed[idx]) continue;
      const old = Math.min(255, Math.max(0, gray[idx]));
      const nv = old < 128 ? 0 : 255;
      const err = old - nv;
      gray[idx] = nv;
      if (x + 1 < w) gray[idx + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) gray[idx + w - 1] += err * 3 / 16;
        gray[idx + w] += err * 5 / 16;
        if (x + 1 < w) gray[idx + w + 1] += err * 1 / 16;
      }
    }
  }

  const rowBytes = w / 4;
  const out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      let code = 0;
      if (isRed[idx]) code = 2;
      else if (gray[idx] < 128) code = 1;
      const byteIndex = y * rowBytes + (x >> 2);
      const shift = 6 - 2 * (x % 4);
      out[byteIndex] |= (code << shift);
    }
  }
  return out;
}
