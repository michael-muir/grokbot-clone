// Serialize a rendered DOM subtree into an SVG with editable <text>, shapes, borders, shadows and nested icons.
window.exportSVG = function (idx) {
  const root = document.getElementById('s' + idx);
  const R = root.getBoundingClientRect();
  const defs = []; let uid = 0; const usedIds = new Map();
  const ctx = document.createElement('canvas').getContext('2d');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = v => parseFloat(v) || 0;
  const f = n => Math.round(n * 100) / 100;
  const uniq = name => { const n = usedIds.get(name) || 0; usedIds.set(name, n + 1); return n ? `${name} ${n + 1}` : name; };
  function parseColor(c) {
    if (!c) return null; const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); const a = p.length > 3 ? p[3] : 1;
    if (a === 0) return null; return { rgb: `rgb(${p[0]},${p[1]},${p[2]})`, a };
  }
  const paintAttr = (c, kind = 'fill') => { const p = parseColor(c); if (!p) return null; return `${kind}="${p.rgb}"${p.a < 1 ? ` ${kind}-opacity="${f(p.a)}"` : ''}`; };
  function splitTop(s) { const out = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && !d) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
  function shapePath(x, y, w, h, r) { // r = [tl,tr,br,bl]
    const [a, b, c, d] = r.map(v => Math.max(0, Math.min(v, w / 2, h / 2)));
    if (a === b && b === c && c === d) return { tag: 'rect', attrs: `x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"${a ? ` rx="${f(a)}"` : ''}` };
    return { tag: 'path', attrs: `d="M${f(x + a)} ${f(y)}H${f(x + w - b)}${b ? `A${f(b)} ${f(b)} 0 0 1 ${f(x + w)} ${f(y + b)}` : ''}V${f(y + h - c)}${c ? `A${f(c)} ${f(c)} 0 0 1 ${f(x + w - c)} ${f(y + h)}` : ''}H${f(x + d)}${d ? `A${f(d)} ${f(d)} 0 0 1 ${f(x)} ${f(y + h - d)}` : ''}V${f(y + a)}${a ? `A${f(a)} ${f(a)} 0 0 1 ${f(x + a)} ${f(y)}` : ''}Z"` };
  }
  const shape = (x, y, w, h, r, extra) => { const s = shapePath(x, y, w, h, r); return `<${s.tag} ${s.attrs} ${extra}/>`; };
  function gradient(bgImg, w, h) {
    let m = bgImg.match(/^linear-gradient\((.*)\)$/); if (!m) { const c = bgImg.match(/rgba?\([^)]+\)/); return c ? { fill: paintAttr(c[0]) } : null; }
    const parts = splitTop(m[1]); let ang = 180; if (/deg/.test(parts[0])) ang = parseFloat(parts.shift());
    const stops = parts.map((p, i) => { const c = p.match(/rgba?\([^)]+\)/)[0]; const pos = p.match(/([\d.]+)%\s*$/); return { c: parseColor(c), pos: pos ? +pos[1] / 100 : i / (parts.length - 1) }; });
    const id = 'g' + (uid++); const rad = (ang - 90) * Math.PI / 180;
    const x1 = 0.5 - Math.cos(rad) / 2, y1 = 0.5 - Math.sin(rad) / 2, x2 = 0.5 + Math.cos(rad) / 2, y2 = 0.5 + Math.sin(rad) / 2;
    defs.push(`<linearGradient id="${id}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}">${stops.map(s => `<stop offset="${f(s.pos)}" stop-color="${s.c.rgb}" stop-opacity="${f(s.c.a)}"/>`).join('')}</linearGradient>`);
    return { fill: `fill="url(#${id})"` };
  }
  function parseShadows(v) {
    if (!v || v === 'none') return [];
    return splitTop(v).map(s => { const c = (s.match(/rgba?\([^)]+\)/) || ['rgba(0,0,0,0)'])[0]; const rest = s.replace(c, '').trim(); const inset = /inset/.test(rest); const n = rest.replace('inset', '').trim().split(/\s+/).map(num); return { inset, x: n[0] || 0, y: n[1] || 0, blur: n[2] || 0, spread: n[3] || 0, color: c }; });
  }
  function textNode(t, cs, out) {
    const raw = t.textContent.replace(/ /g, ' '); if (!raw.trim()) return;
    const parent = t.parentElement; const pr = parent.getBoundingClientRect();
    const clipRight = (cs.textOverflow === 'ellipsis' && cs.overflow === 'hidden') ? pr.right : Infinity;
    const re = /\S+\s*|\s+/g; let m; const lines = [];
    while ((m = re.exec(raw))) {
      const rg = document.createRange(); rg.setStart(t, m.index); rg.setEnd(t, m.index + m[0].length);
      const rects = [...rg.getClientRects()].filter(r => r.width > 0 || /\S/.test(m[0])); if (!rects.length) continue;
      const r = rects[0]; let line = lines.find(l => Math.abs(l.top - r.top) < 3);
      if (!line && !/\S/.test(m[0])) continue; // leading whitespace: start the line at the first visible glyph
      if (!line) { line = { top: r.top, left: r.left, text: '', truncated: false, right: r.right }; lines.push(line); }
      if (r.left >= clipRight - 1) { line.truncated = true; continue; }
      if (r.right > clipRight) { line.truncated = true; }
      line.text += m[0]; line.left = Math.min(line.left, r.left); line.right = r.right;
    }
    const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    const size = num(cs.fontSize), weight = cs.fontWeight;
    ctx.font = `${weight} ${size}px "${fam}"`; const mt = ctx.measureText('Hg'); const asc = mt.fontBoundingBoxAscent;
    const ls = cs.letterSpacing === 'normal' ? 0 : num(cs.letterSpacing);
    const deco = (cs.textDecorationLine || '').includes('underline') ? ' text-decoration="underline"' : '';
    const col = paintAttr(cs.color) || 'fill="rgb(245,245,245)"';
    for (const l of lines) {
      let txt = l.text.replace(/\s+$/, ''); if (!txt) continue; if (l.truncated) txt = txt.replace(/\s*\S{0,2}$/, '') + '…';
      if (/^\s+/.test(txt)) { txt = txt.trimStart(); }
      out.push(`<text x="${f(l.left - R.left)}" y="${f(l.top - R.top + asc)}" font-family="${esc(fam)}" font-size="${size}" font-weight="${weight}"${ls ? ` letter-spacing="${f(ls)}"` : ''}${deco} ${col}${cs.fontStyle === 'italic' ? ' font-style="italic"' : ''}>${esc(txt)}</text>`);
    }
  }
  function walk(el, out) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return;
    const r = el.getBoundingClientRect();
    const x = r.left - R.left, y = r.top - R.top, w = r.width, h = r.height;
    if (el.tagName.toLowerCase() === 'svg') {
      const c = el.cloneNode(true); c.removeAttribute('style'); c.removeAttribute('class');
      c.setAttribute('x', f(x)); c.setAttribute('y', f(y)); c.setAttribute('width', f(w)); c.setAttribute('height', f(h));
      let s = new XMLSerializer().serializeToString(c).replace(/currentColor/g, cs.color).replace(/ xmlns="[^"]*"/, '');
      out.push(s); return;
    }
    const name = el.dataset && el.dataset.n;
    const own = [];
    const radii = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(k => num(cs[`border${k}Radius`]));
    const bg = cs.backgroundImage && cs.backgroundImage !== 'none' ? gradient(cs.backgroundImage, w, h) : (paintAttr(cs.backgroundColor) ? { fill: paintAttr(cs.backgroundColor) } : null);
    const shadows = parseShadows(cs.boxShadow);
    const drop = shadows.find(s => !s.inset && (s.blur > 0 || s.x || s.y) && parseColor(s.color));
    if (bg && w > 0 && h > 0) {
      let filt = '';
      if (drop) { const id = 'f' + (uid++); const pc = parseColor(drop.color); defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${drop.x}" dy="${drop.y}" stdDeviation="${f(drop.blur / 2)}" flood-color="${pc.rgb}" flood-opacity="${f(pc.a)}"/></filter>`); filt = ` filter="url(#${id})"`; }
      own.push(shape(x, y, w, h, radii, `${bg.fill}${filt}`));
    }
    // ring shadows (0 0 0 spread) → strokes
    for (const s of shadows) {
      if (s.blur || s.x || s.y || !s.spread || !parseColor(s.color)) continue;
      const sw = s.spread; const d = s.inset ? sw / 2 : -sw / 2;
      own.push(shape(x + d, y + d, w - 2 * d, h - 2 * d, radii.map(v => Math.max(0, v - d)), `fill="none" ${paintAttr(s.color, 'stroke')} stroke-width="${f(sw)}"`));
    }
    // borders
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map(k => num(cs[`border${k}Width`]));
    const bc = ['Top', 'Right', 'Bottom', 'Left'].map(k => cs[`border${k}Color`]);
    if (bw.every(v => v > 0) && bw.every(v => v === bw[0]) && bc.every(c => c === bc[0])) {
      const p = paintAttr(bc[0], 'stroke'); if (p) { const d = bw[0] / 2; own.push(shape(x + d, y + d, w - 2 * d, h - 2 * d, radii.map(v => Math.max(0, v - d)), `fill="none" ${p} stroke-width="${f(bw[0])}"`)); }
    } else {
      const sides = [[x, y, w, bw[0]], [x + w - bw[1], y, bw[1], h], [x, y + h - bw[2], w, bw[2]], [x, y, bw[3], h]];
      sides.forEach((s, i) => { if (bw[i] > 0) { const p = paintAttr(bc[i]); if (p) own.push(`<rect x="${f(s[0])}" y="${f(s[1])}" width="${f(s[2])}" height="${f(s[3])}" ${p}/>`); } });
    }
    const kids = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) textNode(n, cs, kids);
      else if (n.nodeType === 1) walk(n, kids);
    }
    let inner = own.join('') + kids.join('');
    if (!inner) return;
    const op = +cs.opacity < 1 ? ` opacity="${cs.opacity}"` : '';
    if (name) out.push(`<g id="${esc(uniq(name))}"${op}>${inner}</g>`);
    else if (op) out.push(`<g${op}>${inner}</g>`);
    else if (own.length && kids.length) out.push(`<g>${inner}</g>`);
    else out.push(inner);
  }
  const body = [];
  for (const n of root.childNodes) { if (n.nodeType === 1) walk(n, body); }
  const bgc = paintAttr(getComputedStyle(root).backgroundColor) || 'fill="rgb(18,18,18)"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f(R.width)}" height="${f(R.height)}" viewBox="0 0 ${f(R.width)} ${f(R.height)}"><defs>${defs.join('')}</defs><rect id="Background" x="0" y="0" width="${f(R.width)}" height="${f(R.height)}" ${bgc}/>${body.join('')}</svg>`;
};
