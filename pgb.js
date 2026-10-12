// Чистая логика формата .pgb (без DOM и без pdf.js) — её же гоняет тест в Node.
// Значения ДОЛЖНЫ совпадать с прошивкой (SCREEN_WIDTH/SCREEN_HEIGHT и футер).

export const W = 400;          // ширина экрана
export const H = 300;          // высота экрана
export const FOOTER = 20;      // нижние строки заняты прошивкой (номер стр., WIFI, батарея)
export const CH = H - FOOTER;  // 280 строк контента на «экран»
export const OVERLAP = 14;     // минимальное перекрытие соседних экранов одной PDF-страницы, пикс. (>= высоты строки)
export const LITTLEFS_BYTES = 0xCF0000; // ~12.9 МБ — раздел spiffs из partitions_16mb.csv

// Заголовок 16 байт:
// 0-3 "PGB1" | 4 версия=2 | 5-6 W | 7-8 H | 9-12 число страниц | 13 бит/пиксель | 14 футер | 15 резерв
export function buildHeader(pageCount, bpp) {
  const h = new Uint8Array(16);
  h[0] = 0x50; h[1] = 0x47; h[2] = 0x42; h[3] = 0x31; // "PGB1"
  h[4] = 2;
  h[5] = W & 0xFF; h[6] = (W >> 8) & 0xFF;
  h[7] = H & 0xFF; h[8] = (H >> 8) & 0xFF;
  h[9] = pageCount & 0xFF;
  h[10] = (pageCount >> 8) & 0xFF;
  h[11] = (pageCount >> 16) & 0xFF;
  h[12] = (pageCount >>> 24) & 0xFF;
  h[13] = bpp;
  h[14] = FOOTER;
  return h;
}

export function pageBytes(bpp) {
  return (W * CH * bpp) / 8;
}

// Стартовые строки «экранов» для обрезанной страницы высотой hc (в пикселях при ширине W).
// Число экранов минимальное, при котором соседние перекрываются не меньше OVERLAP;
// экраны распределяются равномерно, последний прижат к низу страницы.
export function computeSliceStarts(hc) {
  if (hc <= CH) return [0];
  const n = Math.ceil((hc - OVERLAP) / (CH - OVERLAP));
  const starts = [];
  for (let i = 0; i < n; i++) starts.push(Math.round((i * (hc - CH)) / (n - 1)));
  return starts;
}

// Границы по профилю (суммы тёмных пикселей по столбцам/строкам), отбрасывая
// выбросы: слева/справа отсекаем по доле frac от общей «массы» тёмных пикселей.
export function percentileBounds(profile, frac) {
  let total = 0;
  for (let i = 0; i < profile.length; i++) total += profile[i];
  if (total === 0) return [0, profile.length - 1];
  const cut = total * frac;
  let acc = 0, lo = 0;
  for (let i = 0; i < profile.length; i++) { acc += profile[i]; if (acc >= cut) { lo = i; break; } }
  acc = 0;
  let hi = profile.length - 1;
  for (let i = profile.length - 1; i >= 0; i--) { acc += profile[i]; if (acc >= cut) { hi = i; break; } }
  return [lo, hi];
}

// Похож ли экран на фото/графику (плоские полутона), а не на текст.
// У антиалиасного текста соседние пиксели сильно различаются; у фото/заливок — почти нет.
function isPhotoLike(lum) {
  let flat = 0;
  for (let y = 1; y < CH - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, v = lum[i];
      if (v > 60 && v < 200 &&
          Math.abs(lum[i - 1] - v) < 18 && Math.abs(lum[i + 1] - v) < 18 &&
          Math.abs(lum[i - W] - v) < 18 && Math.abs(lum[i + W] - v) < 18) flat++;
    }
  }
  return flat > W * CH * 0.03;
}

// rgba: Uint8ClampedArray W*CH*4. Возвращает коды пикселей: 0 белый, 1 чёрный, 2 красный.
// opts: { mode: 'auto'|'text'|'photo', threshold: 0..255, useRed: bool }
export function quantizeSlice(rgba, opts) {
  const n = W * CH;
  const lum = new Float32Array(n);
  const red = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    if (opts.useRed && r > g + 50 && r > b + 50 && r > 110) { red[i] = 1; lum[i] = 255; }
    else lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  let mode = opts.mode;
  if (mode === 'auto') mode = isPhotoLike(lum) ? 'photo' : 'text';

  const codes = new Uint8Array(n);
  if (mode === 'text') {
    const t = opts.threshold;
    for (let i = 0; i < n; i++) codes[i] = red[i] ? 2 : (lum[i] < t ? 1 : 0);
    return codes;
  }

  // Фото: Флойд–Стейнберг, красные пиксели не участвуют в диффузии
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (red[i]) { codes[i] = 2; continue; }
      const old = lum[i] < 0 ? 0 : (lum[i] > 255 ? 255 : lum[i]);
      const nv = old < 128 ? 0 : 255;
      const err = old - nv;
      codes[i] = nv === 0 ? 1 : 0;
      if (x + 1 < W) lum[i + 1] += err * 7 / 16;
      if (y + 1 < CH) {
        if (x > 0) lum[i + W - 1] += err * 3 / 16;
        lum[i + W] += err * 5 / 16;
        if (x + 1 < W) lum[i + W + 1] += err * 1 / 16;
      }
    }
  }
  return codes;
}

// Упаковка кодов в байты ровно так, как читает прошивка (см. drawImageBookPage).
// 1 бит: 1=чёрный, старший бит = левый пиксель. 2 бита: 00/01/10, старшая пара = левый.
export function packCodes(codes, bpp) {
  const out = new Uint8Array(pageBytes(bpp));
  if (bpp === 1) {
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < W; x++) {
        if (codes[y * W + x] !== 0) out[(y * W + x) >> 3] |= 0x80 >> (x & 7);
      }
    }
  } else {
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < W; x++) {
        const c = codes[y * W + x];
        if (c) out[(y * W + x) >> 2] |= c << (6 - 2 * (x & 3));
      }
    }
  }
  return out;
}

// Оценка числа экранов и размера файла (для предупреждения о нехватке места).
// pageWpt/pageHpt — размер PDF-страницы, crop = {l,t,r,b} доли 0..1.
export function estimate(pageWpt, pageHpt, crop, pageCount, bpp) {
  const cw = (crop.r - crop.l) * pageWpt;
  const chpt = (crop.b - crop.t) * pageHpt;
  const scale = W / cw;
  const hc = Math.ceil(chpt * scale);
  const perPage = computeSliceStarts(hc).length;
  const screens = perPage * pageCount;
  const bytes = 16 + screens * pageBytes(bpp);
  return { perPage, screens, bytes };
}
