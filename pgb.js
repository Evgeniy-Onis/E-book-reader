// Чистая логика формата .pgb (без DOM и без pdf.js) — её же гоняет тест в Node.
// Значения ДОЛЖНЫ совпадать с прошивкой (SCREEN_WIDTH/SCREEN_HEIGHT и футер).

export const W = 400;          // ширина экрана
export const H = 300;          // высота экрана
export const FOOTER = 20;      // нижние строки заняты прошивкой (номер стр., WIFI, батарея)
export const CH = H - FOOTER;  // 280 строк контента на «экран»
export const OVERLAP = 14;     // минимальное перекрытие соседних экранов одной PDF-страницы, пикс. (>= высоты строки)
export const LITTLEFS_BYTES = 0xCF0000; // ~12.9 МБ — раздел spiffs из partitions_16mb.csv

// Формат .pgb v3 (прошивка читает также v2):
//   заголовок 16 байт: "PGB1" | 3 | W u16 | H u16 | число экранов u32 | 0 | футер | 0
//   таблица: по u32 LE на экран: бит 31 = «2 бита/пиксель», биты 0..30 = смещение данных от начала файла
//   данные экранов: 1 бит/пикс (1=чёрный) или 2 бита/пикс (00 белый, 01 чёрный, 10 красный), старший бит/пара = левый пиксель.
// Глубина выбирается ПО КАЖДОМУ экрану: чёрно-белые экраны занимают вдвое меньше места.
export function buildHeader(pageCount) {
  const h = new Uint8Array(16);
  h[0] = 0x50; h[1] = 0x47; h[2] = 0x42; h[3] = 0x31; // "PGB1"
  h[4] = 3;
  h[5] = W & 0xFF; h[6] = (W >> 8) & 0xFF;
  h[7] = H & 0xFF; h[8] = (H >> 8) & 0xFF;
  h[9] = pageCount & 0xFF;
  h[10] = (pageCount >> 8) & 0xFF;
  h[11] = (pageCount >> 16) & 0xFF;
  h[12] = (pageCount >>> 24) & 0xFF;
  h[14] = FOOTER;
  return h;
}

// pages: [{ bpp: 1|2, data: Uint8Array }] -> части файла [заголовок, таблица, ...данные]
export function assemblePgb(pages) {
  const n = pages.length;
  const table = new Uint8Array(4 * n);
  const dv = new DataView(table.buffer);
  let off = 16 + 4 * n;
  pages.forEach((p, i) => {
    dv.setUint32(4 * i, ((p.bpp === 2 ? 0x80000000 : 0) | off) >>> 0, true);
    off += p.data.length;
  });
  return [buildHeader(n), table, ...pages.map((p) => p.data)];
}

export function pageBytes(bpp) {
  return (W * CH * bpp) / 8;
}

// Старты «окон» размера size вдоль отрезка total: минимальное число окон, при котором
// соседние перекрываются не меньше overlap; распределены равномерно, последнее прижато к краю.
export function computeStarts(total, size, overlap) {
  if (total <= size) return [0];
  const n = Math.ceil((total - overlap) / (size - overlap));
  const starts = [];
  for (let i = 0; i < n; i++) starts.push(Math.round((i * (total - size)) / (n - 1)));
  return starts;
}
// по вертикали: высота окна = CH
export function computeSliceStarts(hc) { return computeStarts(hc, CH, OVERLAP); }

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

const BLOCK = 16;

// Дизеринг КАК У ОБЛОЖЕК В ПРОШИВКЕ (drawDitheredImage): серый -> Флойд–Стейнберг, 3 уровня:
// <64 чёрный, <192 красный (полутон), иначе белый; ошибка 7/16,3/16,5/16,1/16 с усечением к нулю, как в C.
// gray: Uint8Array w*h. Возвращает коды: 0 белый, 1 чёрный, 2 красный.
export function ditherCover(gray, w, h) {
  const codes = new Uint8Array(w * h);
  let errCur = new Int16Array(w + 2), errNext = new Int16Array(w + 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let old = gray[y * w + x] + errCur[x + 1];
      if (old < 0) old = 0;
      if (old > 255) old = 255;
      const nv = old < 64 ? 0 : (old < 192 ? 128 : 255);
      codes[y * w + x] = nv === 0 ? 1 : (nv === 128 ? 2 : 0);
      const err = old - nv;
      errCur[x + 2] += Math.trunc((err * 7) / 16);
      errNext[x] += Math.trunc((err * 3) / 16);
      errNext[x + 1] += Math.trunc((err * 5) / 16);
      errNext[x + 2] += Math.trunc((err * 1) / 16);
    }
    errCur.set(errNext);
    errNext.fill(0);
  }
  return codes;
}

// ---------- цвет ----------
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
// цветность (хрома OKLab) исходного пикселя: 0 у серого, ~0.26 у чисто красного
function chroma(r, g, b) {
  const R = S2L[r], G = S2L[g], B = S2L[b];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return Math.hypot(a, bb);
}

// «Тон + цвет» — основной режим для цветных картинок.
// Три чернила панели ведут себя как три уровня яркости 0 / 128 / 255 (красный — средний тон, как у обложек
// в прошивке), Флойд–Стейнберг со змейкой в гамма-пространстве. Но красный в роли среднего тона разрешён
// ТОЛЬКО пропорционально цветности исходного пикселя: серое/нейтральное получается чисто чёрно-белым
// (без красных точек), тёплое и красное — красно-чёрно-белыми градациями.
// Подобрано на обложке «Марсианин», нейтральном и цветном фото: штраф P за красный у серых.
export function ditherTone(rgba, w = W, h = CH, o = {}) {
  const P = o.P ?? 160, c0 = o.c0 ?? 0.03, c1 = o.c1 ?? 0.10;
  const n = w * h, v = new Float32Array(n), t = new Float32Array(n), codes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    v[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    t[i] = Math.min(1, Math.max(0, (chroma(r, g, b) - c0) / (c1 - c0)));
  }
  const err = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const rev = y & 1;
    for (let xx = 0; xx < w; xx++) {
      const x = rev ? w - 1 - xx : xx, i = y * w + x;
      let q = v[i] + err[i]; q = q < 0 ? 0 : q > 255 ? 255 : q;
      const cB = q, cW = 255 - q, cR = Math.abs(q - 128) + P * (1 - t[i]);
      let lvl;
      if (cR < cB && cR < cW) { lvl = 128; codes[i] = 2; }
      else if (cB <= cW) { lvl = 0; codes[i] = 1; }
      else { lvl = 255; codes[i] = 0; }
      const e = q - lvl, d = rev ? -1 : 1;
      const put = (dx, dy, f) => { const nx = x + dx * d, ny = y + dy; if (nx >= 0 && nx < w && ny < h) err[ny * w + nx] += e * f; };
      put(1, 0, 7 / 16); put(-1, 1, 3 / 16); put(0, 1, 5 / 16); put(1, 1, 1 / 16);
    }
  }
  return codes;
}

// «Палитра» — подход библиотек для e-paper (epaper-dithering, ImageMagick -remap, Inky): для каждого пикселя
// ближайший цвет из палитры {чёрный, белый, красный} по настоящему цвету, ошибка по RGB, змейка.
export function ditherPalette(rgba, w = W, h = CH) {
  const PAL = [[0, 0, 0], [255, 255, 255], [255, 0, 0]], CODE = [1, 0, 2];
  const n = w * h, buf = new Float32Array(n * 3), codes = new Uint8Array(n);
  for (let i = 0; i < n; i++) { buf[i * 3] = rgba[i * 4]; buf[i * 3 + 1] = rgba[i * 4 + 1]; buf[i * 3 + 2] = rgba[i * 4 + 2]; }
  for (let y = 0; y < h; y++) {
    const rev = y & 1;
    for (let xx = 0; xx < w; xx++) {
      const x = rev ? w - 1 - xx : xx, i = y * w + x;
      const v0 = Math.min(255, Math.max(0, buf[i * 3])), v1 = Math.min(255, Math.max(0, buf[i * 3 + 1])), v2 = Math.min(255, Math.max(0, buf[i * 3 + 2]));
      let best = 0, bd = 1e9;
      for (let k = 0; k < 3; k++) { const d = (v0 - PAL[k][0]) ** 2 + (v1 - PAL[k][1]) ** 2 + (v2 - PAL[k][2]) ** 2; if (d < bd) { bd = d; best = k; } }
      codes[i] = CODE[best];
      const e0 = v0 - PAL[best][0], e1 = v1 - PAL[best][1], e2 = v2 - PAL[best][2], d = rev ? -1 : 1;
      const put = (dx, dy, f) => { const nx = x + dx * d, ny = y + dy; if (nx < 0 || nx >= w || ny >= h) return; const j = (ny * w + nx) * 3; buf[j] += e0 * f; buf[j + 1] += e1 * f; buf[j + 2] += e2 * f; };
      put(1, 0, 7 / 16); put(-1, 1, 3 / 16); put(0, 1, 5 / 16); put(1, 1, 1 / 16);
    }
  }
  return codes;
}

// Классический ч/б Флойд–Стейнберг (без красного) — режим «фото ч/б»
function ditherBW(lum, red) {
  const n = W * CH;
  const codes = new Uint8Array(n);
  const v = Float32Array.from(lum);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (red && red[i]) { codes[i] = 2; continue; }
      const old = v[i] < 0 ? 0 : (v[i] > 255 ? 255 : v[i]);
      const nv = old < 128 ? 0 : 255;
      const err = old - nv;
      codes[i] = nv === 0 ? 1 : 0;
      if (x + 1 < W) v[i + 1] += err * 7 / 16;
      if (y + 1 < CH) {
        if (x > 0) v[i + W - 1] += err * 3 / 16;
        v[i + W] += err * 5 / 16;
        if (x + 1 < W) v[i + W + 1] += err * 1 / 16;
      }
    }
  }
  return codes;
}

// Какие блоки 16x16 — «картинка» (градиенты, заливки, фото), а какие — текст.
// У антиалиасного текста соседи сильно различаются и полутонов мало; у картинок
// либо много плоских полутонов, либо полутона занимают большую часть блока.
export function photoBlocks(lum) {
  const bw = Math.ceil(W / BLOCK), bh = Math.ceil(CH / BLOCK);
  const mask = new Uint8Array(bw * bh);
  const stats = new Float32Array(bw * bh * 3);   // для отладки: доли плоских / полутоновых / белых пикселей в блоке
  const smooth = new Uint8Array(bw * bh);          // гладкий блок: маленький разброс яркости, не чисто белый и не чёрный
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let flat = 0, mid = 0, white = 0, area = 0, sum = 0, mn = 255, mx = 0;
      for (let y = by * BLOCK; y < Math.min(CH, (by + 1) * BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(W, (bx + 1) * BLOCK); x++) {
          area++;
          const i = y * W + x, v = lum[i];
          if (v >= 230) white++;
          sum += v; if (v < mn) mn = v; if (v > mx) mx = v;
          if (v > 60 && v < 200) {
            mid++;
            if (x > 0 && x < W - 1 && y > 0 && y < CH - 1 &&
                Math.abs(lum[i - 1] - v) < 18 && Math.abs(lum[i + 1] - v) < 18 &&
                Math.abs(lum[i - W] - v) < 18 && Math.abs(lum[i + W] - v) < 18) flat++;
          }
        }
      }
      const k = by * bw + bx;
      stats[3 * k] = flat / area; stats[3 * k + 1] = mid / area; stats[3 * k + 2] = white / area;
      // Картинка: много ПЛОСКИХ полутонов (заливки, градиенты, фото) либо фактура, где полутона занимают
      // почти весь блок и почти нет чистого белого. Мелкий плотный текст — это тоже много полутонов
      // (антиалиасинг), но у него всегда есть белый фон и нет плоских участков.
      mask[k] = (flat >= area * 0.2 || (mid >= area * 0.5 && white < area * 0.2)) ? 1 : 0;
      const mean = sum / area;
      smooth[k] = (mx - mn < 45 && mean > 8 && mean < 250) ? 1 : 0;
    }
  }
  const at = (m, x, y) => m[Math.min(bh - 1, Math.max(0, y)) * bw + Math.min(bw - 1, Math.max(0, x))];
  // Одиночные блоки без соседей-картинок — ложные срабатывания на тексте, убираем
  const pruned = new Uint8Array(mask.length);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!mask[y * bw + x]) continue;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && x + dx >= 0 && x + dx < bw && y + dy >= 0 && y + dy < bh && mask[(y + dy) * bw + x + dx]) nb++;
    }
    pruned[y * bw + x] = nb >= 2 ? 1 : 0;
  }
  mask.set(pruned);
  // Замыкание 3x3 (расширить, затем сузить; за краем экрана — копия крайнего блока): закрывает «дырки»
  // внутри картинки (блики/тени без полутонов), но не расширяет картинку наружу на соседний текст.
  const dil = new Uint8Array(mask.length);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let v = 0;
    for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1; dx++) if (at(mask, x + dx, y + dy)) { v = 1; break; }
    dil[y * bw + x] = v;
  }
  const closed = new Uint8Array(mask.length);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let v = 1;
    for (let dy = -1; dy <= 1 && v; dy++) for (let dx = -1; dx <= 1; dx++) if (!at(dil, x + dx, y + dy)) { v = 0; break; }
    closed[y * bw + x] = v;
  }
  for (let k = 0; k < mask.length; k++) mask[k] = mask[k] | closed[k];

  // Рост области (3 шага): гладкие блоки рядом с картинкой — небо, тени, плавные заливки — тоже картинка.
  // Чисто белый фон страницы (255) и текст (большой разброс) сюда не попадают.
  for (let it = 0; it < 3; it++) {
    const add = [];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      if (mask[k] || !smooth[k]) continue;
      if ((x > 0 && mask[k - 1]) || (x < bw - 1 && mask[k + 1]) || (y > 0 && mask[k - bw]) || (y < bh - 1 && mask[k + bw])) add.push(k);
    }
    for (const k of add) mask[k] = 1;
  }

  // Картинки в документах прямоугольные: каждую связную область (>= 6 блоков) заменяем её прямоугольником,
  // чтобы светлые/тёмные участки внутри фото не превращались в «ступеньки» между двумя способами дизеринга.
  // Мелкие обрывки (< 6 блоков) — скорее всего текст, их убираем.
  const seen = new Uint8Array(mask.length), outMask = new Uint8Array(mask.length);
  for (let k0 = 0; k0 < mask.length; k0++) {
    if (!mask[k0] || seen[k0]) continue;
    const stack = [k0]; seen[k0] = 1;
    let minx = bw, maxx = 0, miny = bh, maxy = 0, cnt = 0;
    while (stack.length) {
      const k = stack.pop(), x = k % bw, y = (k / bw) | 0;
      cnt++; minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue;
        const j = ny * bw + nx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (cnt >= 6) for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) outMask[y * bw + x] = 1;
  }
  mask.set(outMask);
  return { mask, bw, bh, stats };
}

// rgba: Uint8ClampedArray W*CH*4. Возвращает коды: 0 белый, 1 чёрный, 2 красный.
// opts: { mode: 'auto'|'tone'|'lum'|'palette'|'photo'|'text', threshold: 0..255, useRed: bool }
//   auto    — текст чётким порогом; картинки и цветная графика — «тон + цвет» (см. ditherTone)
//   tone    — весь экран «тон + цвет»: нейтральное чёрно-белое, цветное красно-чёрно-белыми градациями
//   lum     — как обложки в прошивке: яркость в три уровня (красный — любой средний тон)
//   palette — подход библиотек e-paper: ближайший цвет палитры по RGB
//   photo   — ч/б дизеринг, красный не используется
//   text    — только порог (красный по оттенку, если useRed)
export function quantizeSlice(rgba, opts) {
  const n = W * CH;
  const lum = new Float32Array(n);
  const gray = new Uint8Array(n);
  const red = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    lum[i] = l; gray[i] = Math.floor(l);
    if (opts.useRed && r > g + 50 && r > b + 50 && r > 110) red[i] = 1;
  }

  const textCodes = () => {
    const t = opts.threshold, c = new Uint8Array(n);
    for (let i = 0; i < n; i++) c[i] = red[i] ? 2 : (lum[i] < t ? 1 : 0);
    return c;
  };

  if (opts.mode === 'text') return textCodes();
  if (opts.mode === 'lum') return ditherCover(gray, W, CH);
  if (opts.mode === 'tone') return ditherTone(rgba);
  if (opts.mode === 'palette') return ditherPalette(rgba);
  if (opts.mode === 'photo') return ditherBW(lum, null);   // строго ч/б, красный не используется

  // auto: смешиваем по блокам
  const { mask, bw, bh } = photoBlocks(lum);
  let anyPhoto = false;
  for (let k = 0; k < mask.length; k++) if (mask[k]) { anyPhoto = true; break; }
  const text = textCodes();
  if (!anyPhoto) return text;
  const pic = ditherTone(rgba);
  for (let y = 0; y < CH; y++) {
    const by = Math.floor(y / BLOCK);
    for (let x = 0; x < W; x++) {
      if (mask[by * bw + Math.floor(x / BLOCK)]) text[y * W + x] = pic[y * W + x];
    }
  }
  return text;
}

// есть ли в экране красные пиксели (тогда нужны 2 бита на пиксель)
export function hasRed(codes) {
  for (let i = 0; i < codes.length; i++) if (codes[i] === 2) return true;
  return false;
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

// Оценка числа экранов и размера файла. bytes — минимум (все экраны 1 бит), bytesMax — максимум (все 2 бита).
// pageWpt/pageHpt — размер PDF-страницы, crop = {l,t,r,b} доли 0..1, layout = { mode: 'width' | 'page', zoom: 1..2 }
export function estimate(pageWpt, pageHpt, crop, pageCount, layout = { mode: 'width', zoom: 1 }) {
  const cw = (crop.r - crop.l) * pageWpt;
  const chpt = (crop.b - crop.t) * pageHpt;
  let perPage;
  if (layout.mode === 'page') {
    perPage = 1;
  } else {
    const scale = (W * layout.zoom) / cw;
    const hc = Math.ceil(chpt * scale);
    const wz = Math.round(W * layout.zoom);
    perPage = computeStarts(hc, CH, OVERLAP).length * computeStarts(wz, W, OVERLAP).length;
  }
  const screens = perPage * pageCount;
  const head = 16 + 4 * screens;
  return { perPage, screens, bytes: head + screens * pageBytes(1), bytesMax: head + screens * pageBytes(2) };
}
