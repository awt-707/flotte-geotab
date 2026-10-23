// Contrats de travail : PDF vectoriel bilingue, mise en page du modèle d'Ahmed (français à gauche en Times 12,
// arabe à droite, paragraphes alignés deux à deux, justifiés). pdf-lib pour le document, fontkit pour l'arabe
// (lettres liées, voyelles posées par la police), bidi-js pour l'ordre d'affichage des passages arabes / latins / chiffres.
// Code commun au site (globaux PDFLib, fontkit, bidi_js) et aux tests (Node).
(function (root) {
  'use strict';
  const CTP = { W: 595.28, H: 841.89, top: 58, bottom: 64, frX: 49.35, frW: 248.1, arX: 309.6, arW: 235.1,
    size: 12, lead: 14.4, arSize: 11, arLead: 14.4, gap: 6.6, sigGap: 34 };
  // retraits des listes (début de colonne -> puce, début de colonne -> texte), colonne française / arabe
  const CTP_LIST = { '•': [[18, 36], [2, 18]], '••': [[30, 48], [2, 18]], '-': [[18, 36], [2, 18]],
    '(i)': [[36, 72], [2, 40]], 'A.': [[0, 18], [0, 18]] };
  const AR_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

  /** « <b>gras</b> <i>italique</i> <u>souligné</u> » -> texte + style de chaque caractère (1 gras, 2 italique, 4 souligné) */
  function ctpParse(src) {
    let t = '', sty = [], cur = { b: 0, i: 0, u: 0 };
    String(src == null ? '' : src).split(/(<\/?[biu]>)/).forEach(p => {
      const m = p.match(/^<(\/?)([biu])>$/);
      if (m) { cur[m[2]] = Math.max(0, cur[m[2]] + (m[1] ? -1 : 1)); return; }
      const s = (cur.b ? 1 : 0) | (cur.i ? 2 : 0) | (cur.u ? 4 : 0);
      for (const ch of p.replace(/[\u00a0\u202f]/g, '\u00a0').replace(/[^\S\u00a0]+/g, ' ')) { t += ch; for (let k = 0; k < ch.length; k++) sty.push(s); }
    });
    // espaces en double ou en bord retirés
    let out = '', os = [];
    for (let k = 0; k < t.length; k++) {
      if (t[k] === ' ' && (out === '' || out.endsWith(' '))) continue;
      out += t[k]; os.push(sty[k]);
    }
    while (out.endsWith(' ')) { out = out.slice(0, -1); os.pop(); }
    return { t: out, sty: os };
  }

  async function ctpBuild(blocks, libs, fonts) {
    const { PDFDocument, StandardFonts, PDFHexString, beginText, endText, setFontAndSize, setTextMatrix, showText, rgb } = libs.PDFLib;
    const bidi = libs.bidi;
    const doc = await PDFDocument.create();
    doc.registerFontkit(libs.fontkit);
    doc.setTitle(blocks.title || 'Contrat de travail'); doc.setProducer('Ludy'); doc.setCreator('Ludy');
    const F = {
      t: [await doc.embedFont(StandardFonts.TimesRoman), await doc.embedFont(StandardFonts.TimesRomanBold),
        await doc.embedFont(StandardFonts.TimesRomanItalic), await doc.embedFont(StandardFonts.TimesRomanBoldItalic)],
      n: [await doc.embedFont(fonts.r, { subset: true }), await doc.embedFont(fonts.b, { subset: true })],
      h: await doc.embedFont(StandardFonts.Helvetica)
    };
    // fontkit 1.x s'arrête sur une ancre GPOS absente (permise par OpenType : pas de placement pour ce couple) : ignorée
    F.n.forEach(pf => {
      const le = pf.embedder.font._layoutEngine, g = le && le.engine && le.engine.GPOSProcessor;
      if (g && !g.ctpSafe) { const a = g.applyAnchor; g.applyAnchor = function (m, b, i) { if (m && m.markAnchor && b) a.call(this, m, b, i); }; g.ctpSafe = 1; }
    });
    const winAnsi = new Set(F.t[0].getCharacterSet());
    const shapeCache = new Map();
    function shape(bold, text, rtl) {
      const k = (bold ? 'b' : 'r') + (rtl ? '<' : '>') + text;
      let r = shapeCache.get(k);
      if (!r) {
        const fk = F.n[bold ? 1 : 0].embedder.font;
        const run = fk.layout(text, undefined, rtl ? 'arab' : undefined, undefined, rtl ? 'rtl' : 'ltr');
        r = { glyphs: run.glyphs, pos: run.positions, adv: run.positions.reduce((s, p) => s + p.xAdvance, 0), upm: fk.unitsPerEm };
        shapeCache.set(k, r);
      }
      return r;
    }
    // police d'un caractère : colonne arabe = Noto (arabe + latin) ; colonne française = Times, Noto pour l'arabe
    const fontOf = (ch, col) => col === 'ar' || AR_RE.test(ch) || !winAnsi.has(ch.codePointAt(0)) ? 'n' : 't';
    const sizeOf = col => col === 'ar' ? CTP.arSize : CTP.size;
    function segWidth(sg, size) {
      if (sg.font === 't') return F.t[sg.sty & 3].widthOfTextAtSize(sg.text, size);
      const r = shape(sg.sty & 1, sg.text, sg.rtl);
      return r.adv * size / r.upm;
    }

    /** Paragraphe : texte, niveaux bidi (sens de base de la colonne), segments d'un passage [s, e) dans l'ordre d'affichage */
    function para(src, col) {
      const P = ctpParse(src);
      P.col = col;
      P.levels = P.t ? bidi.getEmbeddingLevels(P.t, col === 'ar' ? 'rtl' : 'ltr').levels : [];
      return P;
    }
    function segments(P, s, e) {
      const out = [];
      let cur = null;
      for (let k = s; k < e; k++) {
        const ch = P.t[k], lv = P.levels[k], st = P.sty[k] & 3, fo = ch === ' ' ? 'sp' : fontOf(ch, P.col);
        if (cur && ch !== ' ' && cur.font === fo && cur.lv === lv && cur.st === st && cur.u === (P.sty[k] & 4)) { cur.e = k + 1; continue; }
        cur = { s: k, e: k + 1, lv: lv, st: st, u: P.sty[k] & 4, font: fo };
        out.push(cur);
        if (ch === ' ') cur = null;
      }
      out.forEach(sg => {
        sg.rtl = sg.lv % 2 === 1;
        let tx = P.t.slice(sg.s, sg.e);
        if (sg.rtl) tx = [...tx].map(c => bidi.getMirroredCharacter(c) || c).join('');
        sg.text = tx; sg.sty = sg.st | sg.u;
        if (sg.font === 'sp') sg.font = P.col === 'ar' ? 'n' : 't';
        sg.sp = tx === ' ';
      });
      // ordre d'affichage (règle L2) : du niveau le plus haut au plus bas niveau impair, inverser chaque suite de segments
      if (out.some(sg => sg.lv > 0)) {
        const max = Math.max(...out.map(sg => sg.lv)), minOdd = Math.min(...out.map(sg => sg.lv % 2 ? sg.lv : sg.lv + 1));
        for (let lv = max; lv >= minOdd; lv--) {
          for (let a = 0; a < out.length;) {
            if (out[a].lv < lv) { a++; continue; }
            let b = a; while (b < out.length && out[b].lv >= lv) b++;
            const rev = out.slice(a, b).reverse(); out.splice(a, b - a, ...rev); a = b;
          }
        }
      }
      return out;
    }
    const widthOf = (P, s, e, size) => segments(P, s, e).reduce((w, sg) => w + segWidth(sg, size), 0);

    /** Coupure en lignes (mots entiers) */
    function lines(P, avail) {
      const size = sizeOf(P.col), out = [];
      if (!P.t) return out;
      const words = [];
      let s = 0;
      for (let k = 0; k <= P.t.length; k++) if (k === P.t.length || P.t[k] === ' ') { if (k > s) words.push({ s: s, e: k }); s = k + 1; }
      words.forEach(w => { w.w = widthOf(P, w.s, w.e, size); });
      const spW = (P.col === 'ar' ? shape(0, ' ', false).adv / 1000 : F.t[0].widthOfTextAtSize(' ', 1)) * size;
      let cur = [], cw = 0;
      const push = () => { out.push({ s: cur[0].s, e: cur[cur.length - 1].e, nat: cw, n: cur.length - 1 }); };
      words.forEach(w => {
        const add = (cur.length ? spW : 0) + w.w;
        if (cur.length && cw + add > avail + 0.01) { push(); cur = [w]; cw = w.w; }
        else { cur.push(w); cw += add; }
      });
      if (cur.length) push();
      out[out.length - 1].last = true;
      return out;
    }

    // une ligne = un bloc de texte ; un repositionnement seulement quand la mise en forme décale un glyphe (voyelles, crénage)
    function keyOf(page, pf) {
      const m = page.ctpKeys || (page.ctpKeys = new Map());
      if (!m.has(pf)) { page.setFont(pf); m.set(pf, page.fontKey); }
      return m.get(pf);
    }
    function drawSeg(page, sg, x, y, size, ops) {
      const sk = sg.sty & 2 ? 0.2 : 0;
      if (sg.font === 't') {
        const pf = F.t[sg.sty & 3];
        ops.push(setFontAndSize(keyOf(page, pf), size), setTextMatrix(1, 0, 0, 1, x, y), showText(pf.encodeText(sg.text)));
        return;
      }
      const pf = F.n[sg.sty & 1], e = pf.embedder, r = shape(sg.sty & 1, sg.text, sg.rtl), k = size / r.upm;
      ops.push(setFontAndSize(keyOf(page, pf), size));
      let pen = x, hex = '';
      const flush = () => { if (hex) ops.push(showText(PDFHexString.of(hex))); hex = ''; };
      r.glyphs.forEach((g, i) => {
        const p = r.pos[i], id = e.subset.includeGlyph(g);
        e.glyphs[id - 1] = g; e.glyphIdMap.set(g.id, id);
        if (i === 0 || p.xOffset || p.yOffset || r.pos[i - 1].xAdvance !== r.glyphs[i - 1].advanceWidth || r.pos[i - 1].xOffset || r.pos[i - 1].yOffset) {
          flush(); ops.push(setTextMatrix(1, 0, sk, 1, pen + p.xOffset * k, y + p.yOffset * k));
        }
        hex += id.toString(16).padStart(4, '0');
        pen += p.xAdvance * k;
      });
      flush();
      e.glyphCache.invalidate();
    }
    function drawLine(page, P, L, x0, w, y, align) {
      const size = sizeOf(P.col), segs = segments(P, L.s, L.e), ws = segs.map(sg => segWidth(sg, size));
      const nat = ws.reduce((a, b) => a + b, 0);
      const extra = align === 'j' && !L.last && L.n > 0 ? Math.max(0, (w - nat) / L.n) : 0;
      const tot = nat + extra * L.n, rtl = P.col === 'ar';
      let x = align === 'c' ? x0 + (w - tot) / 2 : (align === 'e') !== rtl ? x0 + w - tot : x0;
      const ops = [beginText()], lines = [];
      segs.forEach((sg, i) => {
        const sw = ws[i] + (sg.sp ? extra : 0);
        drawSeg(page, sg, x, y, size, ops);   // espaces écrits aussi : texte du PDF copiable mot à mot
        if (sg.u) {
          const nb = segs[i + 1], pv = segs[i - 1];
          if (!sg.sp || (nb && nb.u && pv && pv.u)) lines.push([x, x + sw]);
        }
        x += sw;
      });
      ops.push(endText());
      page.pushOperators(...ops);
      lines.forEach(([a, b]) => page.drawLine({ start: { x: a, y: y - 1.6 }, end: { x: b, y: y - 1.6 }, thickness: 0.6, color: rgb(0, 0, 0) }));
    }

    /** Une cellule (colonne) -> suite d'éléments de hauteur fixe { h, draw(page, yTop) } */
    function cell(list, col) {
      const items = [], X = col === 'ar' ? CTP.arX : CTP.frX, W = col === 'ar' ? CTP.arW : CTP.frW, lead = col === 'ar' ? CTP.arLead : CTP.lead;
      const ci = col === 'ar' ? 1 : 0;
      (Array.isArray(list) ? list : [list]).forEach((d, di) => {
        if (d == null) return;
        if (typeof d === 'string') d = { t: d };
        if (di > 0 || d.before) items.push({ h: d.before != null ? d.before : CTP.gap });
        const P = para(d.t, col);
        const ind = d.list ? CTP_LIST[d.list][ci] : [0, d.ind || 0];
        const tx = col === 'ar' ? X : X + ind[1], tw = W - ind[1];
        const Ls = lines(P, tw);
        if (!Ls.length) { items.push({ h: lead }); return; }
        Ls.forEach((L, li) => items.push({ h: lead, draw: (page, yTop) => {
          const y = yTop - lead * 0.78;
          drawLine(page, P, L, tx, tw, y, d.a || 'j');
          if (li === 0 && d.list) {
            const lab = para(d.label || (d.list === '••' ? '•' : d.list), col), LL = lines(lab, 60)[0];
            const lw = widthOf(lab, LL.s, LL.e, sizeOf(col));
            drawLine(page, lab, LL, col === 'ar' ? X + W - ind[0] - lw : X + ind[0], lw, y, 's');
          }
        } }));
      });
      return items;
    }
    const sum = items => items.reduce((s, it) => s + it.h, 0);

    // ---- pagination ----
    let page = null, y = 0, n = 0;
    const limit = CTP.H - CTP.bottom;
    function newPage() {
      page = doc.addPage([CTP.W, CTP.H]); n++; y = CTP.top;
      const num = String(n), w = F.h.widthOfTextAtSize(num, 9);
      page.drawText(num, { x: CTP.W / 2 - w / 2, y: 50, size: 9, font: F.h });
    }
    newPage();
    function place(fr, ar) {
      let a = 0, b = 0, ya = y, yb = y;
      // chaque colonne avance seule ; nouvelle page quand l'une des deux déborde
      while (a < fr.length || b < ar.length) {
        while (a < fr.length && ya + fr[a].h <= limit + 0.01) { if (fr[a].draw) fr[a].draw(page, CTP.H - ya); ya += fr[a].h; a++; }
        while (b < ar.length && yb + ar[b].h <= limit + 0.01) { if (ar[b].draw) ar[b].draw(page, CTP.H - yb); yb += ar[b].h; b++; }
        if (a < fr.length || b < ar.length) {
          newPage(); ya = yb = y;
          while (a < fr.length && !fr[a].draw) a++;   // pas d'espace en haut de page
          while (b < ar.length && !ar[b].draw) b++;
        }
      }
      y = Math.max(ya, yb);
    }
    const rows = blocks.rows || blocks;
    rows.forEach((r, ri) => {
      if (r.k === 'pb') { if (y > CTP.top) newPage(); return; }
      if (r.k === 'space') { y += r.h; return; }
      if (r.k === 'title') {
        const h = 2 * CTP.lead + 6, boxes = [[CTP.frX + (CTP.frW - 166) / 2, 166, r.fr, 'fr'], [CTP.arX + (CTP.arW - 156) / 2, 156, r.ar, 'ar']];
        boxes.forEach(([x, w, t, col]) => {
          const P = para('<b>' + t + '</b>', col), Ls = lines(P, w - 10), top = CTP.H - y;
          page.drawRectangle({ x: x, y: top - h, width: w, height: h, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
          const lead = col === 'ar' ? CTP.arLead : CTP.lead, y0 = top - (h - Ls.length * lead) / 2;
          Ls.forEach((L, i) => drawLine(page, P, L, x + 5, w - 10, y0 - i * lead - lead * 0.78, 'c'));
        });
        y += h + CTP.gap * 1.5;
        return;
      }
      const fr = cell(r.fr, 'fr'), ar = cell(r.ar, 'ar'), h = Math.max(sum(fr), sum(ar));
      let need = h;
      if (r.next && rows[ri + 1] && rows[ri + 1].fr) need += CTP.gap + 3 * CTP.lead;   // titre gardé avec le début du texte
      if (y > CTP.top && y + need > limit && (r.keep || r.next || h <= 5 * CTP.lead)) newPage();
      place(fr, ar);
      y += r.after != null ? r.after : CTP.gap;
    });
    return doc.save();
  }

  const api = { ctpBuild: ctpBuild, ctpParse: ctpParse, CTP: CTP };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
