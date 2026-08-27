'use strict';
/* ============================================================
   SCANDECK — ブラウザ完結の書類スキャナー
   カメラ撮影 → 四隅補正(斜め補正/指の写り込み除去) →
   影除去 → コントラスト強調 → OCR → 検索可能PDF出力
   すべてブラウザ内で完結(サーバー送信なし)
   ============================================================ */

/* ---------------- state ---------------- */
const state = {
  stream: null,
  facingMode: 'environment',
  pages: [],            // { canvas, finalCanvas, ocrText, ocrWords }
  cropSrcCanvas: null,
  cropQuad: null,
  cvReady: false,
  pdfDoc: null,
};

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const video           = $('video');
const overlayCanvas   = $('overlayCanvas');
const shutterBtn      = $('shutterBtn');
const switchCamBtn    = $('switchCamBtn');
const doneBtn         = $('doneBtn');
const cropStage       = $('cropStage');
const viewfinderSection = $('viewfinderSection');
const cropCanvas      = $('cropCanvas');
const cropSvg         = $('cropSvg');
const retakeBtn       = $('retakeBtn');
const autoDetectBtn   = $('autoDetectBtn');
const confirmCropBtn  = $('confirmCropBtn');
const filmstrip       = $('filmstrip');
const filmstripEmpty  = $('filmstripEmpty');
const pageCount       = $('pageCount');
const processPanel    = $('processPanel');
const processCanvas   = $('processCanvas');
const stageList       = $('stageList');
const downloadBtn     = $('downloadBtn');
const closeProcessBtn = $('closeProcessBtn');
const statusDot       = $('statusDot');
const statusText      = $('statusText');

function setStatus(text, kind){
  statusText.textContent = text;
  statusDot.className = 'readout-dot' + (kind ? ' ' + kind : '');
}

/* ---------------- OpenCV readiness ---------------- */
function onCvReady(){
  state.cvReady = true;
  setStatus('準備完了', 'ready');
}
if (typeof cv !== 'undefined') {
  cv['onRuntimeInitialized'] = onCvReady;
} else {
  // opencv.js の読み込みが遅延した場合に備えてポーリング
  const wait = setInterval(() => {
    if (typeof cv !== 'undefined') {
      clearInterval(wait);
      cv['onRuntimeInitialized'] = onCvReady;
    }
  }, 200);
}

/* ============================================================
   カメラ
   ============================================================ */
async function startCamera(facingMode){
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false
    });
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
    resizeOverlay();
  } catch (err) {
    setStatus('カメラにアクセスできません', 'warn');
    console.error(err);
  }
}

function resizeOverlay(){
  overlayCanvas.width = video.videoWidth || video.clientWidth;
  overlayCanvas.height = video.videoHeight || video.clientHeight;
}

switchCamBtn.addEventListener('click', () => {
  state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
  startCamera(state.facingMode);
});

window.addEventListener('resize', resizeOverlay);
window.addEventListener('load', () => {
  setStatus('カメラ起動中…');
  startCamera(state.facingMode);
});

/* ============================================================
   撮影 → 四隅調整ステージ
   ============================================================ */
shutterBtn.addEventListener('click', () => {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  const c = document.createElement('canvas');
  c.width = vw; c.height = vh;
  c.getContext('2d').drawImage(video, 0, 0, vw, vh);
  state.cropSrcCanvas = c;
  openCropStage(c);
});

function openCropStage(srcCanvas){
  viewfinderSection.classList.add('hidden');
  cropStage.classList.remove('hidden');

  const maxW = 640;
  const scale = Math.min(1, maxW / srcCanvas.width);
  cropCanvas.width = srcCanvas.width * scale;
  cropCanvas.height = srcCanvas.height * scale;
  cropCanvas.getContext('2d').drawImage(srcCanvas, 0, 0, cropCanvas.width, cropCanvas.height);
  cropSvg.setAttribute('viewBox', `0 0 ${cropCanvas.width} ${cropCanvas.height}`);

  const quad = detectQuad(srcCanvas) || defaultQuad(srcCanvas.width, srcCanvas.height);
  state.cropQuad = quad;
  renderCropHandles(scale);
}

function defaultQuad(w, h){
  const mx = w * 0.06, my = h * 0.06;
  return {
    tl: { x: mx, y: my }, tr: { x: w - mx, y: my },
    br: { x: w - mx, y: h - my }, bl: { x: mx, y: h - my }
  };
}

/* ---- OpenCVによる書類の自動輪郭検出 ---- */
function detectQuad(srcCanvas){
  if (!state.cvReady) return null;
  let src, small, gray, edges, contours, hierarchy, best = null;
  try {
    src = cv.imread(srcCanvas);
    const ratio = 800 / src.cols;
    small = new cv.Mat();
    cv.resize(src, small, new cv.Size(Math.round(src.cols * ratio), Math.round(src.rows * ratio)));

    gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150);
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = small.cols * small.rows;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = Math.abs(cv.contourArea(approx));
        if (area > bestArea && area > imgArea * 0.2) {
          bestArea = area;
          if (best) best.delete();
          best = approx;
        } else {
          approx.delete();
        }
      } else {
        approx.delete();
      }
      cnt.delete();
    }

    let quad = null;
    if (best) {
      const pts = [];
      for (let i = 0; i < 4; i++) {
        pts.push({ x: best.intPtr(i, 0)[0] / ratio, y: best.intPtr(i, 0)[1] / ratio });
      }
      quad = orderQuad(pts);
      best.delete();
    }
    return quad;
  } catch (e) {
    console.error('detectQuad error', e);
    return null;
  } finally {
    [src, small, gray, edges, contours, hierarchy].forEach(m => m && m.delete());
  }
}

function orderQuad(pts){
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.x - a.y) - (b.x - b.y));
  return { tl: bySum[0], br: bySum[3], tr: byDiff[0], bl: byDiff[3] };
}

/* ---- 四隅ハンドルのドラッグ操作 ---- */
let handleScale = 1;
function renderCropHandles(scale){
  handleScale = scale;
  cropSvg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';

  const poly = document.createElementNS(ns, 'polygon');
  poly.setAttribute('id', 'cropPoly');
  poly.setAttribute('fill', 'rgba(47,217,199,0.15)');
  poly.setAttribute('stroke', '#2FD9C7');
  poly.setAttribute('stroke-width', '2');
  cropSvg.appendChild(poly);

  ['tl', 'tr', 'br', 'bl'].forEach(key => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('r', '14');
    c.setAttribute('fill', '#E85A4F');
    c.setAttribute('stroke', '#fff');
    c.setAttribute('stroke-width', '2');
    c.dataset.corner = key;
    c.style.cursor = 'grab';
    cropSvg.appendChild(c);
    attachDrag(c, key);
  });
  updateCropSvg();
}

function updateCropSvg(){
  const q = state.cropQuad, s = handleScale;
  const pts = [q.tl, q.tr, q.br, q.bl].map(p => `${p.x * s},${p.y * s}`).join(' ');
  cropSvg.querySelector('#cropPoly').setAttribute('points', pts);
  ['tl', 'tr', 'br', 'bl'].forEach(key => {
    const c = cropSvg.querySelector(`circle[data-corner="${key}"]`);
    c.setAttribute('cx', q[key].x * s);
    c.setAttribute('cy', q[key].y * s);
  });
}

function attachDrag(el, key){
  let dragging = false;
  const getPt = (evt) => {
    const rect = cropSvg.getBoundingClientRect();
    const vb = cropSvg.viewBox.baseVal;
    const x = (evt.clientX - rect.left) * (vb.width / rect.width);
    const y = (evt.clientY - rect.top) * (vb.height / rect.height);
    return { x: x / handleScale, y: y / handleScale };
  };
  el.addEventListener('pointerdown', (e) => { dragging = true; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    state.cropQuad[key] = getPt(e);
    updateCropSvg();
  });
  const end = () => { dragging = false; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

autoDetectBtn.addEventListener('click', () => {
  const q = detectQuad(state.cropSrcCanvas);
  if (q) { state.cropQuad = q; updateCropSvg(); }
  else { setStatus('自動検出できませんでした。手動で調整してください', 'warn'); }
});

retakeBtn.addEventListener('click', () => {
  cropStage.classList.add('hidden');
  viewfinderSection.classList.remove('hidden');
});

/* ---- 透視変換(斜め補正/指の写り込み除去) ---- */
confirmCropBtn.addEventListener('click', () => {
  if (!state.cvReady) { setStatus('画像処理エンジンを読み込み中です…', 'warn'); return; }
  const warped = warpPerspective(state.cropSrcCanvas, state.cropQuad);
  addPage(warped);
  cropStage.classList.add('hidden');
  viewfinderSection.classList.remove('hidden');
});

function warpPerspective(srcCanvas, quad){
  const { tl, tr, br, bl } = quad;
  const widthA = Math.hypot(br.x - bl.x, br.y - bl.y);
  const widthB = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const maxWidth = Math.max(widthA, widthB);
  const heightA = Math.hypot(tr.x - br.x, tr.y - br.y);
  const heightB = Math.hypot(tl.x - bl.x, tl.y - bl.y);
  const maxHeight = Math.max(heightA, heightB);

  const src = cv.imread(srcCanvas);
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, maxWidth, 0, maxWidth, maxHeight, 0, maxHeight]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(maxWidth, maxHeight), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = maxWidth; outCanvas.height = maxHeight;
  cv.imshow(outCanvas, dst);

  [src, dst, M, srcTri, dstTri].forEach(m => m.delete());
  return outCanvas;
}

/* ============================================================
   フィルムストリップ(撮影済みページ管理)
   ============================================================ */
function addPage(canvas){
  state.pages.push({ canvas, finalCanvas: null, ocrText: null, ocrWords: null });
  renderFilmstrip();
}

function renderFilmstrip(){
  filmstrip.querySelectorAll('.film-cell').forEach(n => n.remove());
  filmstripEmpty.classList.toggle('hidden', state.pages.length > 0);
  state.pages.forEach((p, idx) => {
    const cell = document.createElement('div');
    cell.className = 'film-cell';
    const img = document.createElement('img');
    img.src = p.canvas.toDataURL('image/jpeg', 0.7);
    cell.appendChild(img);
    const num = document.createElement('span');
    num.className = 'film-num';
    num.textContent = String(idx + 1).padStart(2, '0');
    cell.appendChild(num);
    const del = document.createElement('button');
    del.className = 'film-del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'このページを削除');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      state.pages.splice(idx, 1);
      renderFilmstrip();
    });
    cell.appendChild(del);
    filmstrip.appendChild(cell);
  });
  pageCount.textContent = String(state.pages.length).padStart(2, '0');
}

/* ============================================================
   影除去(照明ムラ補正)
   背景を推定(膨張+メディアンフィルタ)して差分を正規化する定番手法
   ============================================================ */
function removeShadow(canvas){
  const srcRGBA = cv.imread(canvas);
  const src = new cv.Mat();
  cv.cvtColor(srcRGBA, src, cv.COLOR_RGBA2RGB);

  const channels = new cv.MatVector();
  cv.split(src, channels);
  const resultChannels = new cv.MatVector();
  const kernel = cv.Mat.ones(7, 7, cv.CV_8U);

  for (let i = 0; i < channels.size(); i++) {
    const ch = channels.get(i);
    const bg = new cv.Mat();
    cv.dilate(ch, bg, kernel);
    cv.medianBlur(bg, bg, 21);
    const diff = new cv.Mat();
    cv.absdiff(ch, bg, diff);
    const inv = new cv.Mat();
    cv.bitwise_not(diff, inv);
    const norm = new cv.Mat();
    cv.normalize(inv, norm, 0, 255, cv.NORM_MINMAX, cv.CV_8U);
    resultChannels.push_back(norm);
    ch.delete(); bg.delete(); diff.delete(); inv.delete();
  }
  kernel.delete();

  const merged = new cv.Mat();
  cv.merge(resultChannels, merged);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = canvas.width; outCanvas.height = canvas.height;
  cv.imshow(outCanvas, merged);

  srcRGBA.delete(); src.delete(); channels.delete(); merged.delete();
  for (let i = 0; i < resultChannels.size(); i++) resultChannels.get(i).delete();
  resultChannels.delete();
  return outCanvas;
}

/* ---- コントラスト強調(CLAHE, 文字の読み取りやすさ向上) ---- */
function enhanceContrast(canvas){
  const srcRGBA = cv.imread(canvas);
  const src = new cv.Mat();
  cv.cvtColor(srcRGBA, src, cv.COLOR_RGBA2RGB);
  const lab = new cv.Mat();
  cv.cvtColor(src, lab, cv.COLOR_RGB2Lab);

  const labChannels = new cv.MatVector();
  cv.split(lab, labChannels);
  const l = labChannels.get(0);
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  const l2 = new cv.Mat();
  clahe.apply(l, l2);

  const mergedVec = new cv.MatVector();
  mergedVec.push_back(l2);
  mergedVec.push_back(labChannels.get(1));
  mergedVec.push_back(labChannels.get(2));
  const labOut = new cv.Mat();
  cv.merge(mergedVec, labOut);
  const rgbOut = new cv.Mat();
  cv.cvtColor(labOut, rgbOut, cv.COLOR_Lab2RGB);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = canvas.width; outCanvas.height = canvas.height;
  cv.imshow(outCanvas, rgbOut);

  srcRGBA.delete(); src.delete(); lab.delete(); labChannels.delete();
  l.delete(); l2.delete(); mergedVec.delete(); labOut.delete(); rgbOut.delete();
  clahe.delete();
  return outCanvas;
}

/* ============================================================
   OCR (Tesseract.js, 日本語+英語)
   ============================================================ */
let tesseractWorker = null;
async function getWorker(){
  if (tesseractWorker) return tesseractWorker;
  tesseractWorker = await Tesseract.createWorker('jpn+eng');
  return tesseractWorker;
}

async function runOCR(canvas){
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);
  return data;
}

/* ============================================================
   検索可能PDFの生成(画像+透明テキストレイヤー)
   ============================================================ */
async function buildPDF(){
  const { jsPDF } = window.jspdf;
  let doc = null;
  const pageWpt = 595.28; // A4幅(pt)を基準に各ページの縦横比を保持

  state.pages.forEach((page, idx) => {
    const canvas = page.finalCanvas || page.canvas;
    const imgData = canvas.toDataURL('image/jpeg', 0.85);
    const pageHpt = pageWpt * (canvas.height / canvas.width);

    if (idx === 0) {
      doc = new jsPDF({ unit: 'pt', format: [pageWpt, pageHpt] });
    } else {
      doc.addPage([pageWpt, pageHpt]);
    }
    doc.addImage(imgData, 'JPEG', 0, 0, pageWpt, pageHpt);

    if (page.ocrWords && page.ocrWords.length) {
      const scaleX = pageWpt / canvas.width;
      const scaleY = pageHpt / canvas.height;
      doc.setFont('helvetica');
      doc.setTextColor(255, 255, 255);
      page.ocrWords.forEach(w => {
        if (!w.text || !w.text.trim() || !w.bbox) return;
        const x = w.bbox.x0 * scaleX;
        const y = w.bbox.y1 * scaleY;
        const h = (w.bbox.y1 - w.bbox.y0) * scaleY;
        const fontSize = Math.max(4, h * 0.85);
        doc.setFontSize(fontSize);
        try {
          doc.text(w.text, x, y, { renderingMode: 'invisible' });
        } catch (e) { /* 認識不能な文字はスキップ */ }
      });
    }
  });
  return doc;
}

/* ============================================================
   処理パイプライン(影除去 → コントラスト → OCR → PDF)
   ============================================================ */
doneBtn.addEventListener('click', async () => {
  if (state.pages.length === 0) { setStatus('先に撮影してください', 'warn'); return; }
  processPanel.classList.remove('hidden');
  try {
    await runPipeline();
  } catch (e) {
    console.error(e);
    setStatus('処理中にエラーが発生しました', 'warn');
  }
});

closeProcessBtn.addEventListener('click', () => {
  processPanel.classList.add('hidden');
  resetStageList();
});

function setStageActive(stage){
  stageList.querySelectorAll('li').forEach(li => li.classList.remove('active'));
  const li = stageList.querySelector(`li[data-stage="${stage}"]`);
  li.classList.add('active');
  li.querySelector('.stage-state').textContent = '処理中';
}
function setStageDone(stage){
  const li = stageList.querySelector(`li[data-stage="${stage}"]`);
  li.classList.remove('active');
  li.classList.add('done');
  li.querySelector('.stage-state').textContent = '完了';
}
function resetStageList(){
  stageList.querySelectorAll('li').forEach(li => {
    li.classList.remove('active', 'done');
    li.querySelector('.stage-state').textContent = '待機';
  });
  downloadBtn.classList.add('hidden');
  closeProcessBtn.classList.add('hidden');
}
function tick(){ return new Promise(r => setTimeout(r, 30)); }

async function runPipeline(){
  resetStageList();
  const pctx = processCanvas.getContext('2d');

  setStageActive('shadow');
  for (const page of state.pages) {
    const shadowFree = removeShadow(page.canvas);
    processCanvas.width = shadowFree.width;
    processCanvas.height = shadowFree.height;
    pctx.drawImage(shadowFree, 0, 0);
    page.finalCanvas = shadowFree;
    await tick();
  }
  setStageDone('shadow');

  setStageActive('enhance');
  for (const page of state.pages) {
    const enhanced = enhanceContrast(page.finalCanvas);
    pctx.drawImage(enhanced, 0, 0);
    page.finalCanvas = enhanced;
    await tick();
  }
  setStageDone('enhance');

  setStageActive('ocr');
  for (const page of state.pages) {
    const data = await runOCR(page.finalCanvas);
    page.ocrText = data.text;
    page.ocrWords = (data.words || []).map(w => ({ text: w.text, bbox: w.bbox }));
  }
  setStageDone('ocr');

  setStageActive('pdf');
  const doc = await buildPDF();
  state.pdfDoc = doc;
  setStageDone('pdf');

  downloadBtn.classList.remove('hidden');
  closeProcessBtn.classList.remove('hidden');
  setStatus('PDF作成完了', 'ready');
}

downloadBtn.addEventListener('click', () => {
  if (!state.pdfDoc) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  state.pdfDoc.save(`scandeck_${stamp}.pdf`);
});
