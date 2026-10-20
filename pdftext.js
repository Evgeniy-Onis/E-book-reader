// Текст из PDF с текстовым слоем -> абзацы -> FB2 (без DOM и без pdf.js, тестируется в Node).
// Вход: страницы вида { n, w, h, items:[{ str, x, y, h, w }] } (координаты PDF: y растёт вверх).

// ---------- очистка под шрифт ридера (ASCII + кириллица) ----------
const MAP = {
  '\u00A0': ' ', '\u2002': ' ', '\u2003': ' ', '\u2009': ' ', '\u200A': ' ', '\u202F': ' ',
  '\u00AD': '', '\u200B': '', '\u200C': '', '\u200D': '', '\uFEFF': '',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u2032': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u00AB': '"', '\u00BB': '"', '\u2033': '"',
  '\u2026': '...', '\u2022': '-', '\u00B7': '.', '\u25CF': '-', '\u25AA': '-', '\u2023': '-',
  '\u00A7': 'п.', '\u00B0': 'гр.', '\u00B1': '+/-', '\u00D7': 'x', '\u00F7': '/', '\u2248': '~',
  '\u2264': '<=', '\u2265': '>=', '\u2260': '!=', '\u2192': '->', '\u2190': '<-', '\u2116': 'N',
  '\u20AC': 'EUR', '\u00A9': '(c)', '\u00AE': '(R)', '\u2122': '(TM)', '\u00BD': '1/2', '\u00BC': '1/4', '\u00BE': '3/4',
  '\uFB01': 'fi', '\uFB02': 'fl', '\uFB00': 'ff', '\uFB03': 'ffi', '\uFB04': 'ffl',
};

export function cleanForFont(str) {
  let s = str.normalize('NFC');
  let out = '';
  for (const ch of s) {
    if (MAP[ch] !== undefined) { out += MAP[ch]; continue; }
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) { out += ' '; continue; }
    if ((c >= 0x20 && c <= 0x7E) || (c >= 0x400 && c <= 0x52F)) { out += ch; continue; }
    if (c >= 0xC0 && c <= 0x24F) { // латинские буквы с диакритикой -> без неё
      out += ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      continue;
    }
    // прочее (иероглифы, символы без глифа в шрифте) отбрасываем
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

// ---------- вспомогательное ----------
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const percentile = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// ---------- колонки ----------
function splitColumns(items, pageW) {
  const real = items.filter((i) => i.str.trim());
  if (real.length < 40) return [items];
  const B = 120;
  const cov = new Float64Array(B);
  for (const it of real) {
    const a = Math.max(0, Math.floor((it.x / pageW) * B));
    const b = Math.min(B - 1, Math.floor(((it.x + it.w) / pageW) * B));
    for (let k = a; k <= b; k++) cov[k]++;
  }
  const nonEmpty = Array.from(cov).filter((v) => v > 0);
  const base = median(nonEmpty);
  if (!base) return [items];
  // ищем самую длинную «пустую» полосу в средней части страницы
  let best = null, runStart = -1;
  for (let k = Math.floor(B * 0.3); k <= Math.ceil(B * 0.7); k++) {
    const empty = cov[k] <= base * 0.03;
    if (empty && runStart < 0) runStart = k;
    if ((!empty || k === Math.ceil(B * 0.7)) && runStart >= 0) {
      const end = empty ? k : k - 1;
      if (end - runStart + 1 >= 3 && (!best || end - runStart > best[1] - best[0])) best = [runStart, end];
      runStart = -1;
    }
  }
  if (!best) return [items];
  const gStart = (best[0] / B) * pageW, gEnd = ((best[1] + 1) / B) * pageW, g = (gStart + gEnd) / 2;
  let crossing = 0;
  for (const it of real) if (it.x < gStart && it.x + it.w > gEnd) crossing++;
  if (crossing > real.length * 0.04) return [items];
  const left = items.filter((i) => i.x + i.w / 2 < g), right = items.filter((i) => i.x + i.w / 2 >= g);
  const lr = real.filter((i) => i.x + i.w / 2 < g).length;
  if (lr < real.length * 0.25 || real.length - lr < real.length * 0.25) return [items];
  return [left, right];
}

// ---------- элементы -> строки ----------
function buildLines(items) {
  const its = items.filter((i) => i.str.length > 0);
  if (!its.length) return [];
  const med = median(its.filter((i) => i.str.trim()).map((i) => i.h)) || 10;
  const tol = Math.max(1, med * 0.45);
  its.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const groups = [];
  let cur = null;
  for (const it of its) {
    if (cur && Math.abs(cur.y - it.y) <= tol) {
      cur.items.push(it);
      cur.y = (cur.y * (cur.items.length - 1) + it.y) / cur.items.length;
    } else { cur = { y: it.y, items: [it] }; groups.push(cur); }
  }
  const lines = [];
  for (const g of groups) {
    g.items.sort((a, b) => a.x - b.x);
    let text = '', last = null;
    const sizes = new Map();
    let x0 = Infinity, x1 = -Infinity;
    for (const it of g.items) {
      if (last) {
        const gap = it.x - (last.x + last.w);
        if (gap > Math.max(0.2 * it.h, 1) && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
      }
      text += it.str;
      last = it;
      const t = it.str.trim();
      if (t) {
        x0 = Math.min(x0, it.x); x1 = Math.max(x1, it.x + it.w);
        const key = Math.round(it.h * 2) / 2;
        sizes.set(key, (sizes.get(key) || 0) + t.length);
      }
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || !isFinite(x0)) continue;
    let size = 0, cnt = -1;
    for (const [k, v] of sizes) if (v > cnt) { size = k; cnt = v; }
    lines.push({ text, x0, x1, y: g.y, size });
  }
  return lines;
}

const END_SENT = /[.!?…:;»"”)\]]\s*$/;
const LIST_MARK = /^([-–—•*·]\s|\d{1,3}[.)]\s|[a-zа-яё][.)]\s)/i;
const PAGE_NUM = /^[\s\-–—.()]*((стр\.?|страница|page|p\.)\s*)?\d{1,4}(\s*(из|of|\/)\s*\d{1,4})?[\s\-–—.()]*$/i;

// ---------- главная функция ----------
// opts: { removeHeaders: bool, dehyphenate: bool }
export function extractParagraphs(pages, opts = {}) {
  const removeHeaders = opts.removeHeaders !== false;
  const dehyph = opts.dehyphenate !== false;

  // 1. строки по страницам/колонкам
  const pageCols = pages.map((pg) => {
    const cols = splitColumns(pg.items, pg.w).map((c) => buildLines(c));
    for (const col of cols) for (const l of col) {
      const rel = l.y / pg.h;
      l.band = rel > 0.93 ? 'top' : (rel < 0.07 ? 'bottom' : 'body');
    }
    return { pg, cols };
  });

  // 2. колонтитулы: повторяющиеся строки в верхней/нижней полосе + «голые» номера страниц
  const dropped = new Set();
  let droppedCount = 0;
  if (removeHeaders) {
    const counts = new Map();
    for (const { cols } of pageCols) {
      const seen = new Set();
      for (const col of cols) for (const l of col) if (l.band !== 'body') {
        const k = l.band + '|' + l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
        if (!seen.has(k)) { seen.add(k); counts.set(k, (counts.get(k) || 0) + 1); }
      }
    }
    const need = Math.max(3, Math.ceil(pages.length * 0.3));
    for (const { cols } of pageCols) for (const col of cols) for (const l of col) {
      if (l.band === 'body') continue;
      const k = l.band + '|' + l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
      if ((counts.get(k) || 0) >= need || PAGE_NUM.test(l.text)) { dropped.add(l); droppedCount++; }
    }
  }

  // 3. базовый размер шрифта
  const sizeVotes = [];
  for (const { cols } of pageCols) for (const col of cols) for (const l of col) {
    if (dropped.has(l)) continue;
    for (let k = 0; k < Math.min(l.text.length, 200); k += 20) sizeVotes.push(l.size);
  }
  const body = median(sizeVotes) || 10;

  // 4. сборка абзацев
  const paras = [];
  let curP = null, prev = null;
  const flush = () => { if (curP) { paras.push(curP); curP = null; } };

  let pagesWithText = 0;
  for (const { cols } of pageCols) {
    let any = false;
    for (const col of cols) {
      const lines = col.filter((l) => !dropped.has(l));
      if (!lines.length) continue;
      any = true;
      const left = percentile(lines.map((l) => l.x0), 0.15);
      const right = percentile(lines.map((l) => l.x1), 0.85);
      const dys = [];
      for (let i = 1; i < lines.length; i++) { const d = lines[i - 1].y - lines[i].y; if (d > 0) dys.push(d); }
      const spacing = median(dys) || body * 1.2;

      lines.forEach((l, idx) => {
        const heading = (l.size > body * 1.1 && l.text.length < 140) ||
          (l.text.length >= 3 && l.text.length <= 80 && !/[a-zа-яё]/.test(l.text) && /[A-ZА-ЯЁ]{3}/.test(l.text) && !/[.,;]$/.test(l.text));
        const first = idx === 0;
        let newPara;
        if (!curP) newPara = true;
        else if (curP.type === 'h' !== heading) newPara = true;
        else if (heading) newPara = Math.abs(l.size - (prev ? prev.size : l.size)) > 0.5;
        else {
          const gap = prev ? prev.y - l.y : 0;
          const indent = l.x0 - left > 0.8 * body;
          const listItem = LIST_MARK.test(l.text);
          const prevShort = prev && prev.x1 < right - 3 * body && END_SENT.test(curP.text);
          newPara = (!first && gap > 1.7 * spacing) || indent || listItem || prevShort;
          if (first && !indent && !listItem && !END_SENT.test(curP.text)) newPara = false; // абзац продолжается на новой странице/колонке
          if (first && END_SENT.test(curP.text) && !prevShort) newPara = true;
        }
        if (newPara) { flush(); curP = { type: heading ? 'h' : 'p', text: l.text }; }
        else if (dehyph && /[\p{L}]-$/u.test(curP.text) && /^[a-zа-яё]/.test(l.text)) curP.text = curP.text.slice(0, -1) + l.text;
        else curP.text += ' ' + l.text;
        prev = l;
      });
    }
    if (any) pagesWithText++;
  }
  flush();

  const paragraphs = [];
  for (const p of paras) {
    const t = cleanForFont(p.text);
    if (t.length) paragraphs.push({ type: p.type, text: t });
  }
  const chars = paragraphs.reduce((s, p) => s + p.text.length, 0);
  return { paragraphs, stats: { chars, droppedLines: droppedCount, pagesWithText, pages: pages.length } };
}

// Есть ли у PDF текстовый слой (по числу символов на страницу)
export function detectTextLayer(charsPerPage) {
  const n = charsPerPage.length;
  if (!n) return { text: false, ratio: 0, avg: 0 };
  const good = charsPerPage.filter((c) => c >= 200).length;
  return { text: good / n >= 0.5, ratio: good / n, avg: charsPerPage.reduce((a, b) => a + b, 0) / n };
}

// ---------- FB2 ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Прошивка читает абзац максимум ~8 КБ — длинные режем по границе предложения
export function splitLong(text, max = 6000) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function buildFb2(title, paragraphs) {
  const t = esc(cleanForFont(title) || 'Книга');
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">\n' +
    `<description><title-info><genre>nonfiction</genre><book-title>${t}</book-title><lang>ru</lang></title-info></description>\n` +
    '<body>\n<section>\n' + `<subtitle>${t}</subtitle>\n`;
  for (const p of paragraphs) {
    for (const chunk of splitLong(p.text)) out += p.type === 'h' ? `<subtitle>${esc(chunk)}</subtitle>\n` : `<p>${esc(chunk)}</p>\n`;
  }
  return out + '</section>\n</body>\n</FictionBook>\n';
}

// Сколько экранов займёт текст на ридере (14 строк × ~93 байта UTF-8, красная строка, заголовки крупнее)
export function estimateTextScreens(paragraphs) {
  const enc = new TextEncoder();
  let lines = 0;
  for (const p of paragraphs) {
    const bytes = enc.encode(p.text).length;
    lines += Math.max(1, Math.ceil(bytes / 93)) * (p.type === 'h' ? 1.3 : 1);
  }
  return Math.ceil(lines / 14);
}
