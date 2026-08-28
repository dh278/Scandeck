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
  activeFacingMode: null,
  pages: [],            // { canvas, finalCanvas, ocrText, ocrWords }
  cropSrcCanvas: null,
  cropQuad: null,
  cvReady: false,
  pdfDoc: null,
  uploadQueue: [],
  paperSize: 'other',
};

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const video           = $('video');
const overlayCanvas   = $('overlayCanvas');
const shutterBtn      = $('shutterBtn');
const switchCamBtn    = $('switchCamBtn');
const uploadBtn       = $('uploadBtn');
const fileInput       = $('fileInput');
const nativeCaptureInput = $('nativeCaptureInput');
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
const reviewStage     = $('reviewStage');
const reviewGrid      = $('reviewGrid');
const reviewContinueBtn = $('reviewContinueBtn');
const paperChoice     = $('paperChoice');
const paperSizeBtns   = document.querySelectorAll('.paper-size-btn');
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
  // 既に同じ向きのカメラが起動中なら、再度アクセス要求しない
  if (state.stream && state.activeFacingMode === facingMode) {
    return;
  }
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
    state.activeFacingMode = facingMode;
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
/* ---- 端末の向き(縦/横)を取得する ---- */

shutterBtn.addEventListener('click', () => {
  // iOS Safariは高解像度スチル撮影用のImageCapture APIに非対応なため、
  // 動画プレビューから切り出す方式だと解像度が足りず(特にA3など大きい書類で)
  // 文字が潰れてしまう。そこでシャッターは端末純正カメラアプリを呼び出し、
  // OSのフル解像度(12MP以上)で撮影する方式にしている。
  nativeCaptureInput.setAttribute('capture', state.facingMode === 'user' ? 'user' : 'environment');
  nativeCaptureInput.click();
});

nativeCaptureInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  nativeCaptureInput.value = '';
  if (!file) return;
  try {
    const raw = await fileToCanvas(file);
    state.cropSrcCanvas = raw;
    retakeBtn.textContent = '撮り直す';
    openCropStage(raw);
  } catch (err) {
    console.error(err);
    setStatus('撮影した写真を読み込めませんでした', 'warn');
  }
});

/* ============================================================
   写真ファイルからのアップロード
   ============================================================ */
uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  fileInput.value = ''; // 同じファイルを連続で選んでもchangeが発火するようにリセット
  if (!files.length) return;
  state.uploadQueue = files;
  processNextUpload();
});

function fileToCanvas(file){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      resolve(c);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function processNextUpload(){
  if (!state.uploadQueue.length) return;
  const file = state.uploadQueue.shift();
  try {
    const canvas = await fileToCanvas(file);
    state.cropSrcCanvas = canvas;
    retakeBtn.textContent = state.uploadQueue.length > 0 ? 'スキップ' : 'キャンセル';
    openCropStage(canvas);
  } catch (e) {
    console.error('file load error', e);
    setStatus('画像を読み込めませんでした', 'warn');
    await processNextUpload();
  }
}

// 四隅調整を終えた後、アップロード待ちがあれば次のファイルへ、なければビューファインダーに戻る
function proceedAfterCrop(){
  if (state.uploadQueue.length > 0) {
    processNextUpload();
  } else {
    cropStage.classList.add('hidden');
    viewfinderSection.classList.remove('hidden');
  }
}

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

/* ---- OpenCVによる書類の自動輪郭検出 ----
   紙サイズの判定はやめ、その分「本当に書類の輪郭を見つけられるか」の
   精度に全振りする。Canny法(しきい値2種)+大津の二値化、計3種類の
   手法を試し、見つかった中で一番面積が大きい有効な四角形を採用する
   アンサンブル方式にすることで、照明条件や背景の違いに強くする。 */
function detectQuad(srcCanvas){
  if (!state.cvReady) return null;
  let small, gray;
  try {
    // ネイティブカメラ由来の写真は12MP超になることがあり、フル解像度のまま
    // OpenCVのMatに変換すると非常に重くなる(ボタンを押しても反応がないように
    // 見える原因)。そのため、まず軽量なCanvas2Dで縮小してからOpenCVに渡す。
    const targetW = 1000;
    const scaleRatio = Math.min(1, targetW / srcCanvas.width);
    const smallCanvas = document.createElement('canvas');
    smallCanvas.width = Math.max(1, Math.round(srcCanvas.width * scaleRatio));
    smallCanvas.height = Math.max(1, Math.round(srcCanvas.height * scaleRatio));
    smallCanvas.getContext('2d').drawImage(srcCanvas, 0, 0, smallCanvas.width, smallCanvas.height);

    small = canvasToMat(smallCanvas);
    gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);

    const candidates = [];

    // 手法1・2: Canny法をしきい値を変えて2回試す
    [[50, 150], [30, 100]].forEach(([lo, hi]) => {
      const blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
      const edges = new cv.Mat();
      cv.Canny(blurred, edges, lo, hi);
      const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edges, edges, kernel);
      kernel.delete();
      collectQuadCandidates(edges, small, candidates);
      blurred.delete(); edges.delete();
    });

    // 手法3: 大津の二値化(書類と背景の明暗差が大きい場合に強い)
    const thresh = new cv.Mat();
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    collectQuadCandidates(thresh, small, candidates);
    thresh.delete();

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.area - a.area);
    const bestQuad = candidates[0].quad;

    // 縮小画像上の座標だったので元解像度に戻す
    const scaleBack = (p) => ({ x: p.x / scaleRatio, y: p.y / scaleRatio });
    return {
      tl: scaleBack(bestQuad.tl), tr: scaleBack(bestQuad.tr),
      br: scaleBack(bestQuad.br), bl: scaleBack(bestQuad.bl)
    };
  } catch (e) {
    console.error('detectQuad error', e);
    return null;
  } finally {
    [small, gray].forEach(m => m && m.delete());
  }
}

// 二値化/エッジ画像から、有効な(凸な4点で一定以上の面積を持つ)四角形候補を集める
function collectQuadCandidates(binaryMat, refMat, candidates){
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binaryMat, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const imgArea = refMat.cols * refMat.rows;
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const area = Math.abs(cv.contourArea(approx));
      if (area > imgArea * 0.15) {
        const pts = [];
        for (let j = 0; j < 4; j++) {
          pts.push({ x: approx.intPtr(j, 0)[0], y: approx.intPtr(j, 0)[1] });
        }
        candidates.push({ area, quad: orderQuad(pts) });
      }
    }
    approx.delete();
    cnt.delete();
  }
  contours.delete();
  hierarchy.delete();
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

autoDetectBtn.addEventListener('click', async () => {
  autoDetectBtn.disabled = true;
  autoDetectBtn.textContent = '検出中…';
  // 一度描画を挟んでからでないと、重い処理中はボタンの表示が変わらず
  // 「反応していない」ように見えてしまう
  await new Promise((resolve) => setTimeout(resolve, 30));
  const q = detectQuad(state.cropSrcCanvas);
  autoDetectBtn.disabled = false;
  autoDetectBtn.textContent = '自動検出';
  if (q) { state.cropQuad = q; updateCropSvg(); }
  else { setStatus('自動検出できませんでした。手動で調整してください', 'warn'); }
});

retakeBtn.addEventListener('click', () => {
  proceedAfterCrop();
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
  } else if (type === 'rotate180') {
    c.width = srcCanvas.width; c.height = srcCanvas.height;
    ctx.translate(c.width, c.height);
    ctx.rotate(Math.PI);
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

/* ---- 指定した縦横比へのスナップ補正 ----
   用紙サイズが選ばれたとき、はみ出した分を中央基準でクロップして
   その比率にきっちり合わせる(引き伸ばしはしない=文字は歪まない)。 */
function snapToAspectRatio(canvas, targetRatio){
  const w = canvas.width, h = canvas.height;
  const portrait = h >= w;
  let targetW = w, targetH = h;
  if (portrait) {
    const idealH = w * targetRatio;
    if (idealH <= h) { targetH = Math.round(idealH); }
    else { targetW = Math.round(h / targetRatio); }
  } else {
    const idealW = h * targetRatio;
    if (idealW <= w) { targetW = Math.round(idealW); }
    else { targetH = Math.round(w / targetRatio); }
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
  const warped = warpPerspective(state.cropSrcCanvas, state.cropQuad);
  addPage(warped);
  proceedAfterCrop();
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
  // 用紙サイズ(短辺)のpt換算値(1mm = 2.83465pt)。A2/A3/A4はすべて縦横比が同じ(1:√2)。
  const PAPER_SHORT_SIDE_PT = { a4: 595.28, a3: 841.89, a2: 1190.55 };

  state.pages.forEach((page, idx) => {
    const canvas = page.finalCanvas || page.canvas;
    const imgData = canvas.toDataURL('image/jpeg', 0.94);
    const portrait = canvas.height >= canvas.width;

    let pageWpt, pageHpt;
    const shortSide = PAPER_SHORT_SIDE_PT[state.paperSize];
    if (shortSide) {
      // A2/A3/A4が選ばれていれば、その用紙の実寸(pt)でページを作る
      const longSide = shortSide * Math.SQRT2;
      pageWpt = portrait ? shortSide : longSide;
      pageHpt = portrait ? longSide : shortSide;
    } else {
      // 「その他」= 検出した縦横比のまま、A4幅を基準に換算するだけ
      pageWpt = 595.28;
      pageHpt = pageWpt * (canvas.height / canvas.width);
    }

    if (idx === 0) {
      doc = new jsPDF({ unit: 'pt', format: [pageWpt, pageHpt], orientation: portrait ? 'p' : 'l' });
    } else {
      doc.addPage([pageWpt, pageHpt], portrait ? 'p' : 'l');
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
  reviewStage.classList.add('hidden');
  paperChoice.classList.add('hidden');
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

  // ここで一旦止めて、仕上がりを見ながら向きを手動確認・修正してもらう
  await showReviewStage();

  // 用紙サイズを選んでもらい、指定があればその比率にきっちり合わせる
  await showPaperSizeStage();

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

/* ---- 向き手動レビュー画面 ---- */
function renderReviewGrid(){
  reviewGrid.innerHTML = '';
  state.pages.forEach((page, idx) => {
    const cell = document.createElement('div');
    cell.className = 'review-cell';

    const img = document.createElement('img');
    img.src = page.finalCanvas.toDataURL('image/jpeg', 0.6);
    cell.appendChild(img);

    const controls = document.createElement('div');
    controls.className = 'review-cell-controls';

    const rotL = document.createElement('button');
    rotL.textContent = '↺';
    rotL.setAttribute('aria-label', `ページ${idx + 1}を左回転`);
    rotL.addEventListener('click', () => {
      page.finalCanvas = transformCanvas(page.finalCanvas, 'rotateCCW');
      page.canvas = transformCanvas(page.canvas, 'rotateCCW');
      renderReviewGrid();
    });

    const rot180 = document.createElement('button');
    rot180.textContent = '↕';
    rot180.setAttribute('aria-label', `ページ${idx + 1}を180度回転`);
    rot180.addEventListener('click', () => {
      page.finalCanvas = transformCanvas(page.finalCanvas, 'rotate180');
      page.canvas = transformCanvas(page.canvas, 'rotate180');
      renderReviewGrid();
    });

    const rotR = document.createElement('button');
    rotR.textContent = '↻';
    rotR.setAttribute('aria-label', `ページ${idx + 1}を右回転`);
    rotR.addEventListener('click', () => {
      page.finalCanvas = transformCanvas(page.finalCanvas, 'rotateCW');
      page.canvas = transformCanvas(page.canvas, 'rotateCW');
      renderReviewGrid();
    });

    controls.appendChild(rotL);
    controls.appendChild(rot180);
    controls.appendChild(rotR);
    cell.appendChild(controls);
    reviewGrid.appendChild(cell);
  });
}

function showReviewStage(){
  return new Promise((resolve) => {
    renderReviewGrid();
    scanWindow.classList.add('hidden');
    reviewStage.classList.remove('hidden');
    const handler = () => {
      reviewStage.classList.add('hidden');
      scanWindow.classList.remove('hidden');
      reviewContinueBtn.removeEventListener('click', handler);
      resolve();
    };
    reviewContinueBtn.addEventListener('click', handler);
  });
}

/* ---- 用紙サイズ選択(A2/A3/A4/その他) ----
   A2・A3・A4はどれも縦横比が同じ(1:√2)なので、選ばれたらその比率に
   きっちりクロップする。「その他」は今の形のまま何もしない。 */
function showPaperSizeStage(){
  return new Promise((resolve) => {
    scanWindow.classList.add('hidden');
    paperChoice.classList.remove('hidden');
    const handler = (e) => {
      const size = e.currentTarget.dataset.size;
      state.paperSize = size;
      if (size !== 'other') {
        state.pages.forEach(page => {
          page.finalCanvas = snapToAspectRatio(page.finalCanvas, Math.SQRT2);
        });
      }
      paperSizeBtns.forEach(b => b.removeEventListener('click', handler));
      paperChoice.classList.add('hidden');
      scanWindow.classList.remove('hidden');
      resolve();
    };
    paperSizeBtns.forEach(b => b.addEventListener('click', handler));
  });
}

downloadBtn.addEventListener('click', () => {
  if (!state.pdfDoc) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  state.pdfDoc.save(`scandeck_${stamp}.pdf`);
});
