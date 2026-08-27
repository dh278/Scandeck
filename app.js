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
const rotateCcwBtn    = $('rotateCcwBtn');
const rotateCwBtn     = $('rotateCwBtn');
const flipHBtn        = $('flipHBtn');
const filmstrip       = $('filmstrip');
const filmstripEmpty  = $('filmstripEmpty');
const pageCount       = $('pageCount');
const processPanel    = $('processPanel');
const ocrChoice       = $('ocrChoice');
const ocrYesBtn       = $('ocrYesBtn');
const ocrNoBtn        = $('ocrNoBtn');
const scanWindow      = $('scanWindow');
const processCanvas   = $('processCanvas');
const stageList       = $('stageList');
const downloadBtn     = $('downloadBtn');
const closeProcessBtn = $('closeProcessBtn');
const statusDot       = $('statusDot');
const statusText      = $('statusText');
const engineBanner    = $('engineBanner');

function setStatus(text, kind){
  statusText.textContent = text;
  statusDot.className = 'readout-dot' + (kind ? ' ' + kind : '');
}

/* ---------------- OpenCVの読み込み状態をボタン/バナーに反映 ---------------- */
function updateEngineBanner(){
  const ready = state.cvReady;
  engineBanner.classList.toggle('hidden', ready);
  confirmCropBtn.disabled = !ready;
  confirmCropBtn.style.opacity = ready ? '1' : '0.5';
  confirmCropBtn.textContent = ready ? 'この範囲で確定' : '読み込み中…';
}

/* ---------------- OpenCV readiness ---------------- */
function onCvReady(){
  state.cvReady = true;
  setStatus('準備完了', 'ready');
  updateEngineBanner();
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
// 読み込みが極端に遅い/失敗している場合にネットワーク要因を案内する
setTimeout(() => {
  if (!state.cvReady) {
    engineBanner.textContent = '画像処理エンジンの読み込みに時間がかかっています。通信環境を確認するか、ページを再読み込みしてください';
    setStatus('エンジン読込が遅延中', 'warn');
  }
}, 15000);

/* ============================================================
   カメラ
   ============================================================ */
async function startCamera(facingMode){
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
  }
  const videoConstraints = (mode, exact) => ({
    video: {
      facingMode: exact ? { exact: mode } : { ideal: mode },
      width: { ideal: 3000 }, height: { ideal: 4000 }
    },
    audio: false
  });
  try {
    let stream;
    try {
      // まず背面/前面カメラを厳密指定(意図しないカメラが選ばれるのを防ぐ)
      stream = await navigator.mediaDevices.getUserMedia(videoConstraints(facingMode, true));
    } catch (e) {
      // 端末によっては exact 指定が失敗するため ideal にフォールバック
      stream = await navigator.mediaDevices.getUserMedia(videoConstraints(facingMode, false));
    }
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
  updateEngineBanner();
}

function defaultQuad(w, h){
  const mx = w * 0.06, my = h * 0.06;
  return {
    tl: { x: mx, y: my }, tr: { x: w - mx, y: my },
    br: { x: w - mx, y: h - my }, bl: { x: mx, y: h - my }
  };
}

/* ---- OpenCVによる書類の自動輪郭検出 ---- */
// A4・A3はどちらも縦横比が1:√2(≒1:1.414)なので、その比率に近い
// 四角形を優先して選ぶことで検出精度を上げる。
const DOC_ASPECT = Math.SQRT2;
function quadAspectScore(quad){
  const w = (dist(quad.tl, quad.tr) + dist(quad.bl, quad.br)) / 2;
  const h = (dist(quad.tl, quad.bl) + dist(quad.tr, quad.br)) / 2;
  if (w <= 0 || h <= 0) return 0;
  const ratio = Math.max(w, h) / Math.min(w, h);
  const diff = Math.abs(ratio - DOC_ASPECT);
  // 比率が近いほど1に近く、0.5以上ずれたら0点になる緩やかな評価
  return Math.max(0, 1 - diff / 0.5);
}
function dist(a, b){ return Math.hypot(a.x - b.x, a.y - b.y); }

function detectQuad(srcCanvas){
  if (!state.cvReady) return null;
  let src, small, gray, edges, contours, hierarchy, best = null;
  try {
    src = canvasToMat(srcCanvas);
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
    let bestScore = 0;
    let bestQuad = null;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = Math.abs(cv.contourArea(approx));
        if (area > imgArea * 0.2) {
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.intPtr(j, 0)[0], y: approx.intPtr(j, 0)[1] });
          }
          const quadCandidate = orderQuad(pts);
          // 面積を主な判断材料にしつつ、A4/A3比率(1:1.414)に近いほど
          // ごく僅かに加点する程度に留める(強く効かせると、撮影角度による
          // 見た目のゆがみで本来の書類より小さい輪郭を誤選択してしまうため)
          const areaScore = area / imgArea;
          const score = areaScore + 0.12 * quadAspectScore(quadCandidate);
          if (score > bestScore) {
            bestScore = score;
            bestQuad = quadCandidate;
          }
        }
      }
      approx.delete();
      cnt.delete();
    }

    if (!bestQuad) return null;
    // 縮小画像上の座標だったので元解像度に戻す
    const scaleBack = (p) => ({ x: p.x / ratio, y: p.y / ratio });
    return {
      tl: scaleBack(bestQuad.tl), tr: scaleBack(bestQuad.tr),
      br: scaleBack(bestQuad.br), bl: scaleBack(bestQuad.bl)
    };
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
  // tl=x+y最小, br=x+y最大, tr=x-y最大, bl=x-y最小
  return { tl: bySum[0], br: bySum[3], tr: byDiff[3], bl: byDiff[0] };
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

/* ---- 回転・左右反転(鏡文字/横向きの補正) ---- */
function transformCanvas(srcCanvas, type){
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (type === 'flipH') {
    c.width = srcCanvas.width; c.height = srcCanvas.height;
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(srcCanvas, 0, 0);
  } else if (type === 'rotateCW') {
    c.width = srcCanvas.height; c.height = srcCanvas.width;
    ctx.translate(c.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(srcCanvas, 0, 0);
  } else if (type === 'rotateCCW') {
    c.width = srcCanvas.height; c.height = srcCanvas.width;
    ctx.translate(0, c.height);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(srcCanvas, 0, 0);
  }
  return c;
}

function applyTransform(type){
  state.cropSrcCanvas = transformCanvas(state.cropSrcCanvas, type);
  openCropStage(state.cropSrcCanvas);
}
rotateCcwBtn.addEventListener('click', () => applyTransform('rotateCCW'));
rotateCwBtn.addEventListener('click', () => applyTransform('rotateCW'));
flipHBtn.addEventListener('click', () => applyTransform('flipH'));

/* ---- canvas → OpenCV Mat 変換(cv.imreadを使わない自前実装) ---- */
function canvasToMat(canvas){
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return cv.matFromImageData(imgData);
}

/* ---- OpenCV Mat → canvas 変換(cv.imshowを使わない自前実装) ----
   一部のOpenCV.jsビルドでcv.imread/cv.imshowが縦横を取り違える不具合があるため、
   ImageDataを直接組み立てて回避する。 */
function matToCanvas(mat){
  let rgba = mat;
  let needsDelete = false;
  if (mat.channels() === 3) {
    rgba = new cv.Mat();
    cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA);
    needsDelete = true;
  } else if (mat.channels() === 1) {
    rgba = new cv.Mat();
    cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
    needsDelete = true;
  }
  const outCanvas = document.createElement('canvas');
  outCanvas.width = rgba.cols;
  outCanvas.height = rgba.rows;
  const imgData = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  outCanvas.getContext('2d').putImageData(imgData, 0, 0);
  if (needsDelete) rgba.delete();
  return outCanvas;
}

/* ---- A4/A3サイズへのスナップ補正 ----
   輪郭検出が多少ズレても、最終的な縦横比がA4/A3(1:1.414)に近ければ
   その比率へきっちり合わせる(はみ出した分を中央基準でクロップするだけで、
   引き伸ばしはしない=文字が歪まない)。全く違う比率の場合はそのまま返す。 */
function snapToStandardAspect(canvas){
  const target = Math.SQRT2; // A4/A3の縦横比 ≒ 1.4142
  const w = canvas.width, h = canvas.height;
  const ratio = Math.max(w, h) / Math.min(w, h);
  const tolerance = 0.12; // ここから±12%程度ズレていたら書類サイズと見なさない
  if (Math.abs(ratio - target) > tolerance) return canvas;

  const portrait = h >= w;
  let targetW = w, targetH = h;
  if (portrait) {
    const idealH = w * target;
    if (idealH <= h) { targetH = Math.round(idealH); }
    else { targetW = Math.round(h / target); }
  } else {
    const idealW = h * target;
    if (idealW <= w) { targetW = Math.round(idealW); }
    else { targetH = Math.round(w / target); }
  }
  if (targetW === w && targetH === h) return canvas;

  const offsetX = Math.floor((w - targetW) / 2);
  const offsetY = Math.floor((h - targetH) / 2);
  const out = document.createElement('canvas');
  out.width = targetW; out.height = targetH;
  out.getContext('2d').drawImage(canvas, offsetX, offsetY, targetW, targetH, 0, 0, targetW, targetH);
  return out;
}

/* ---- 透視変換(斜め補正/指の写り込み除去) ---- */
confirmCropBtn.addEventListener('click', () => {
  if (!state.cvReady) { updateEngineBanner(); return; }
  let warped = warpPerspective(state.cropSrcCanvas, state.cropQuad);
  warped = snapToStandardAspect(warped);
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

  const src = canvasToMat(srcCanvas);
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, maxWidth, 0, maxWidth, maxHeight, 0, maxHeight]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(maxWidth, maxHeight), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

  const outCanvas = matToCanvas(dst);

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
  const srcRGBA = canvasToMat(canvas);
  const src = new cv.Mat();
  cv.cvtColor(srcRGBA, src, cv.COLOR_RGBA2RGB);

  const channels = new cv.MatVector();
  cv.split(src, channels);
  const resultChannels = new cv.MatVector();

  for (let i = 0; i < channels.size(); i++) {
    const ch = channels.get(i);

    // 大きくぼかして「照明のムラ(≒影の形)」だけを背景として推定する
    const bg = new cv.Mat();
    cv.GaussianBlur(ch, bg, new cv.Size(0, 0), 25);

    // 元画像を背景の明るさで割ることでムラを均す(差分方式よりノイズが増えにくい)
    const chF = new cv.Mat(), bgF = new cv.Mat(), normF = new cv.Mat(), norm8 = new cv.Mat();
    ch.convertTo(chF, cv.CV_32F);
    bg.convertTo(bgF, cv.CV_32F, 1, 1); // ゼロ除算防止に+1
    cv.divide(chF, bgF, normF, 255);
    normF.convertTo(norm8, cv.CV_8U);

    resultChannels.push_back(norm8);
    ch.delete(); bg.delete(); chF.delete(); bgF.delete(); normF.delete();
  }

  const merged = new cv.Mat();
  cv.merge(resultChannels, merged);

  const outCanvas = matToCanvas(merged);

  srcRGBA.delete(); src.delete(); channels.delete(); merged.delete();
  for (let i = 0; i < resultChannels.size(); i++) resultChannels.get(i).delete();
  resultChannels.delete();
  return outCanvas;
}

/* ---- コントラスト強調(CLAHE, 文字の読み取りやすさ向上) ---- */
function enhanceContrast(canvas){
  const srcRGBA = canvasToMat(canvas);
  const src = new cv.Mat();
  cv.cvtColor(srcRGBA, src, cv.COLOR_RGBA2RGB);
  const lab = new cv.Mat();
  cv.cvtColor(src, lab, cv.COLOR_RGB2Lab);

  const labChannels = new cv.MatVector();
  cv.split(lab, labChannels);
  const l = labChannels.get(0);
  const clahe = new cv.CLAHE(1.3, new cv.Size(8, 8));
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

  const outCanvas = matToCanvas(rgbOut);

  srcRGBA.delete(); src.delete(); lab.delete(); labChannels.delete();
  l.delete(); l2.delete(); mergedVec.delete(); labOut.delete(); rgbOut.delete();
  clahe.delete();
  return outCanvas;
}

/* ============================================================
   OCR (Tesseract.js, 日本語)
   速度優先のため既定は日本語のみ。英数字混在の書類が多い場合は
   下の 'jpn' を 'jpn+eng' に変更すると精度は上がるが低速になる。
   ============================================================ */
let tesseractWorker = null;
async function getWorker(){
  if (tesseractWorker) return tesseractWorker;
  tesseractWorker = await Tesseract.createWorker('jpn');
  return tesseractWorker;
}

// OCRは画素数が多いほど時間がかかるため、認識専用に縮小したコピーを作る
// (PDFに使う画像本体は元解像度のまま別途保持しているので画質には影響しない)
const OCR_MAX_DIMENSION = 1600;
function downscaleForOcr(canvas){
  const longSide = Math.max(canvas.width, canvas.height);
  if (longSide <= OCR_MAX_DIMENSION) return canvas;
  const scale = OCR_MAX_DIMENSION / longSide;
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

async function runOCR(canvas){
  const worker = await getWorker();
  const ocrInput = downscaleForOcr(canvas);
  const { data } = await worker.recognize(ocrInput);
  // 縮小画像で認識した座標を、PDFに使う元解像度の座標系に変換し直す
  const scaleX = canvas.width / ocrInput.width;
  const scaleY = canvas.height / ocrInput.height;
  const words = (data.words || []).map(w => ({
    text: w.text,
    bbox: {
      x0: w.bbox.x0 * scaleX, y0: w.bbox.y0 * scaleY,
      x1: w.bbox.x1 * scaleX, y1: w.bbox.y1 * scaleY
    }
  }));
  return { text: data.text, words };
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
    const imgData = canvas.toDataURL('image/jpeg', 0.94);
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
doneBtn.addEventListener('click', () => {
  if (state.pages.length === 0) { setStatus('先に撮影してください', 'warn'); return; }
  processPanel.classList.remove('hidden');
  ocrChoice.classList.remove('hidden');
  scanWindow.classList.add('hidden');
  stageList.classList.add('hidden');
  downloadBtn.classList.add('hidden');
  closeProcessBtn.classList.add('hidden');
});

async function startPipeline(withOcr){
  ocrChoice.classList.add('hidden');
  scanWindow.classList.remove('hidden');
  stageList.classList.remove('hidden');
  try {
    await runPipeline(withOcr);
  } catch (e) {
    console.error(e);
    setStatus('処理中にエラーが発生しました', 'warn');
  }
}
ocrYesBtn.addEventListener('click', () => startPipeline(true));
ocrNoBtn.addEventListener('click', () => startPipeline(false));

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
function setStageSkipped(stage){
  const li = stageList.querySelector(`li[data-stage="${stage}"]`);
  li.classList.remove('active');
  li.classList.add('done');
  li.querySelector('.stage-state').textContent = 'スキップ';
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

async function runPipeline(withOcr){
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

  if (withOcr) {
    setStageActive('ocr');
    for (const page of state.pages) {
      const result = await runOCR(page.finalCanvas);
      page.ocrText = result.text;
      page.ocrWords = result.words;
    }
    setStageDone('ocr');
  } else {
    for (const page of state.pages) { page.ocrText = null; page.ocrWords = null; }
    setStageSkipped('ocr');
  }

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
