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
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let flat = 0, mid = 0, white = 0, area = 0;
      for (let y = by * BLOCK; y < Math.min(CH, (by + 1) * BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(W, (bx + 1) * BLOCK); x++) {
          area++;
          const i = y * W + x, v = lum[i];
          if (v >= 230) white++;
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
  return { mask, bw, bh, stats };
}

// rgba: Uint8ClampedArray W*CH*4. Возвращает коды: 0 белый, 1 чёрный, 2 красный.
// opts: { mode: 'auto'|'cover'|'text'|'photo', threshold: 0..255, useRed: bool }
//   auto  — текст чётким порогом, картинки/цветная графика — как обложки (чёрный+красный+белый, градации)
//   cover — весь экран как обложка
//   text  — только порог (красный по оттенку, если useRed)
//   photo — ч/б дизеринг, красный не используется вообще
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
  if (opts.mode === 'cover') return ditherCover(gray, W, CH);
  if (opts.mode === 'photo') return ditherBW(lum, null);   // строго ч/б, красный не используется

  // auto: смешиваем по блокам
  const { mask, bw, bh } = photoBlocks(lum);
  let anyPhoto = false;
  for (let k = 0; k < mask.length; k++) if (mask[k]) { anyPhoto = true; break; }
  const text = textCodes();
  if (!anyPhoto) return text;
  const pic = ditherCover(gray, W, CH);
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
