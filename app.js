// ===================================================================
// パーソナルカラー診断 MVP v2 — メインコントローラ
// 写真→(白タップWB)→Face色抽出→問診→16タイプ→結果
// v2: ローディング/進捗/撮影品質警告/判定根拠/印刷/安全フォールバック
// ===================================================================
import { QUESTIONS, SEASONS, WEDDING_BY_SEASON, TYPE_EXTRA } from './data.js';
import { extractFeatures, computeWB, rgbToLab } from './analyzer.js?v=3';
import { diagnose } from './diagnosis.js?v=2';

const $=s=>document.querySelector(s);
const FACE_MODEL='https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const VISION='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9';
const BOOKING_URL='#'; // ← LINE登録 / 予約フォーム / UTAGE等のURLに差し替え

const state={ canvas:null, ctx:null, W:0, H:0, imageData:null, wb:{r:1,g:1,b:1}, wbSet:false, features:null, loaded:false, objURL:null };
let faceLandmarker=null;

function setStatus(t){ const el=$('#pc-status'); if(el) el.textContent=t; }
// 隠れたエラーを画面に出す（リモート診断用）
window.addEventListener('error', e=>{ setStatus('⚠️ エラー: '+(e.message||e.error)); });
window.addEventListener('unhandledrejection', e=>{ setStatus('⚠️ エラー: '+((e.reason&&e.reason.message)||e.reason)); });
function showLoading(t){ $('#pc-loading-text').textContent=t||'処理中…'; $('#pc-loading').hidden=false; }
function hideLoading(){ $('#pc-loading').hidden=true; }

// ---- 診断開始の表示切替 ----
function revealTool(){ const s=$('#start'); s.hidden=false; s.scrollIntoView({behavior:'smooth',block:'start'}); }
document.querySelectorAll('.js-reveal').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();revealTool();}));

// ---- HEIC(iPhone写真) デコーダ遅延ロード ----
// heic-to: 新しめのlibheif(wasm)で、iPhoneのHEVCプロファイルにも対応（heic2anyは古く非対応だった）
let _heicMod=null;
function getHeic(){ if(!_heicMod) _heicMod=import('https://cdn.jsdelivr.net/npm/heic-to/+esm'); return _heicMod; }

// ---- blob を canvas に描画して状態に保存 ----
function loadImageBlob(blob){
  if(state.objURL) URL.revokeObjectURL(state.objURL);
  state.objURL=URL.createObjectURL(blob);
  const img=new Image();
  img.onload=()=>{
    const maxW=460, sc=Math.min(1, maxW/img.width);
    const W=Math.round(img.width*sc), H=Math.round(img.height*sc);
    const cv=$('#pc-canvas'); cv.width=W; cv.height=H;
    const ctx=cv.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(img,0,0,W,H);
    state.canvas=cv; state.ctx=ctx; state.W=W; state.H=H;
    state.imageData=ctx.getImageData(0,0,W,H).data;
    state.loaded=true; state.wb={r:1,g:1,b:1}; state.wbSet=false;
    URL.revokeObjectURL(state.objURL); state.objURL=null;
    $('#pc-preview').hidden=false; $('#pc-after-upload').hidden=false; $('#pc-warn').hidden=true;
    setStatus('写真を読み込みました。画像内の「白い部分」(白い服・歯・白目・白い紙)をタップすると精度が上がります（任意）。');
  };
  img.onerror=()=>{ hideLoading(); setStatus('⚠️ この画像形式は表示できませんでした。JPEGまたはPNGでお試しください。'); };
  img.src=state.objURL;
}

// ---- 写真を処理（ファイル選択 / ペースト / ドロップ 共通） ----
async function handleFile(f){
  if(!f){ setStatus('画像が取得できませんでした。'); return; }
  setStatus(`画像を処理中… (${f.name||'貼り付け画像'} / 形式: ${f.type||'不明'} / ${(f.size/1024/1024).toFixed(1)}MB)`);
  const strongHeic = /image\/(heic|heif)/i.test(f.type) || /\.(heic|heif)$/i.test(f.name||'');
  const heicLike = strongHeic || (f.type==='' && f.size>0);
  if(heicLike){
    try{
      showLoading('iPhoneの写真(HEIC)をJPEGに変換しています…');
      const mod=await getHeic();
      const jpg=await mod.heicTo({ blob:f, type:'image/jpeg', quality:0.9 });
      hideLoading();
      loadImageBlob(jpg);
      return;
    }catch(err){
      hideLoading(); console.error(err);
      if(strongHeic){
        setStatus('⚠️ HEICの変換に失敗しました（'+((err&&err.message)||err)+'）。iPhoneの設定→カメラ→フォーマット→「互換性優先」にするか、写真をJPEGで書き出してお試しください。');
        return;
      }
      // type空のJPEG等だった場合は通常読込へ
      loadImageBlob(f);
      return;
    }
  }
  loadImageBlob(f);
}

// (1) ファイル選択
$('#pc-file').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f){ setStatus('ファイルが選択されませんでした。'); return; }
  handleFile(f);
});

// (2) 貼り付け（⌘V / Ctrl+V）— ページのどこでもOK。Finderからのファイル/画像コンテンツ両対応
document.addEventListener('paste', e=>{
  const dt=e.clipboardData; if(!dt) return;
  if(dt.files && dt.files.length){ e.preventDefault(); revealTool(); handleFile(dt.files[0]); return; }
  for(const it of (dt.items||[])){
    if(it.kind==='file'){ const f=it.getAsFile(); if(f){ e.preventDefault(); revealTool(); handleFile(f); return; } }
  }
});

// (3) ドラッグ&ドロップ
(function(){
  const dz=$('#pc-upload'); if(!dz) return;
  ['dragover','dragenter'].forEach(ev=>dz.addEventListener(ev,e=>{ e.preventDefault(); dz.classList.add('pc-drag'); }));
  ['dragleave'].forEach(ev=>dz.addEventListener(ev,e=>{ e.preventDefault(); dz.classList.remove('pc-drag'); }));
  dz.addEventListener('drop',e=>{ e.preventDefault(); dz.classList.remove('pc-drag'); const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]; if(f) handleFile(f); });
})();

// ---- 白タップ WB ----
$('#pc-canvas').addEventListener('click',ev=>{
  if(!state.loaded) return;
  const cv=state.canvas, rect=cv.getBoundingClientRect();
  const x=Math.round((ev.clientX-rect.left)/rect.width*state.W);
  const y=Math.round((ev.clientY-rect.top)/rect.height*state.H);
  const o=(y*state.W+x)*4, d=state.imageData;
  state.wb=computeWB(d[o],d[o+1],d[o+2]); state.wbSet=true;
  state.ctx.putImageData(new ImageData(new Uint8ClampedArray(state.imageData),state.W,state.H),0,0);
  state.ctx.strokeStyle='#C25E4B'; state.ctx.lineWidth=2;
  state.ctx.beginPath(); state.ctx.arc(x,y,8,0,Math.PI*2); state.ctx.stroke();
  setStatus('✓ ホワイトバランスを補正しました。「色を解析する」へ進んでください。');
});

// ---- MediaPipe Face 遅延ロード ----
async function ensureFace(){
  if(faceLandmarker) return;
  showLoading('AIモデルを初期化しています…（初回のみ数秒）');
  const vision=await import(`${VISION}/vision_bundle.mjs`);
  const fileset=await vision.FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  faceLandmarker=await vision.FaceLandmarker.createFromOptions(fileset,{
    baseOptions:{ modelAssetPath:FACE_MODEL }, runningMode:'IMAGE', numFaces:1,
  });
}

// ---- 色を解析 ----
$('#pc-analyze').addEventListener('click',async()=>{
  if(!state.loaded){ setStatus('先に写真をアップロードしてください。'); return; }
  try{
    await ensureFace();
    showLoading('顔と色を解析しています…');
    const res=faceLandmarker.detect(state.canvas);
    const lms=res.faceLandmarks&&res.faceLandmarks[0];
    if(!lms){ hideLoading(); setStatus('⚠️ 顔を検出できませんでした。明るく正面・顔が大きく写った別の写真でお試しください。'); return; }
    state.landmarks=lms;
    state.features=extractFeatures(lms, state.imageData, state.W, state.H, state.wb);
    hideLoading();
    showExtracted(state.features);
    showWarnings(state.features);
    buildQuestions();
    $('#pc-questions').hidden=false;
    $('#pc-questions').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(err){
    console.error(err); hideLoading();
    setStatus('⚠️ AIモデルの読み込みに失敗しました。通信環境を確認し、ページを再読み込みしてお試しください。');
  }
});

function showExtracted(f){
  if(!f){ return; }
  const sw=(rgb)=>`rgb(${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)})`;
  $('#pc-extracted').hidden=false;
  $('#pc-extracted-body').innerHTML=`
    <div class="pc-ext-item"><span class="pc-ext-sw" style="background:${sw(f.skinRGB)}"></span>抽出した肌の色</div>
    <div class="pc-ext-item">アンダートーン: <b>${f.hueSignal>=0?'黄み寄り':'青み寄り'}</b>${state.wbSet?'':' <small>(WB未補正/参考)</small>'}</div>
    <div class="pc-ext-item">明度: <b>${f.valueSignal>=0.3?'明るい':f.valueSignal<=-0.3?'暗め':'中間'}</b></div>
    <div class="pc-ext-item">コントラスト: <b>${f.contrastSignal>=0.3?'高め':f.contrastSignal<=-0.3?'低め':'中間'}</b></div>`;
}
function showWarnings(f){
  const w=(f&&f.quality&&f.quality.warnings)||[];
  if(!w.length){ $('#pc-warn').hidden=true; return; }
  $('#pc-warn').hidden=false;
  $('#pc-warn').innerHTML='⚠️ 精度に影響する可能性：'+w.map(x=>`<span>${x}</span>`).join('');
}

// ---- 問診UI ----
function buildQuestions(){
  const wrap=$('#pc-questions-list'); wrap.innerHTML='';
  QUESTIONS.forEach((q,qi)=>{
    const fs=document.createElement('fieldset'); fs.className='pc-q';
    fs.innerHTML=`<legend>Q${qi+1}. ${q.q}</legend>`;
    const opts=document.createElement('div'); opts.className='pc-opts';
    q.o.forEach((op,oi)=>{
      const lab=document.createElement('label'); lab.className='pc-opt';
      lab.innerHTML=`<input type="radio" name="q${qi}" value="${oi}"><span>${op.t}</span>`;
      opts.appendChild(lab);
    });
    fs.appendChild(opts); wrap.appendChild(fs);
  });
  wrap.addEventListener('change', updateProgress);
  updateProgress();
}
function updateProgress(){
  const total=QUESTIONS.length;
  const done=QUESTIONS.filter((q,qi)=>document.querySelector(`input[name="q${qi}"]:checked`)).length;
  $('#pc-progress-bar').style.width=(done/total*100)+'%';
  $('#pc-progress-text').textContent=`${done} / ${total} 問`;
}

// ---- 診断実行 ----
$('#pc-diagnose').addEventListener('click',()=>{
  const answers=QUESTIONS.map((q,qi)=>{
    const sel=document.querySelector(`input[name="q${qi}"]:checked`);
    return sel ? q.o[+sel.value] : null;
  });
  const answered=answers.filter(Boolean).length;
  if(answered<6){ alert('できるだけ多く（最低6問）お答えください。現在 '+answered+' 問です。'); return; }
  const result=diagnose(state.features, answers, state.wbSet);
  renderResult(result);
  $('#pc-result').hidden=false;
  $('#pc-result').scrollIntoView({behavior:'smooth',block:'start'});
});

// ---- 結果描画 ----
function renderResult(r){
  const t=r.first, s=SEASONS[t.season];
  const wd=WEDDING_BY_SEASON[t.season];
  const ex=TYPE_EXTRA[t.id]||{wd:'',charm:''};
  const hasBooking = BOOKING_URL && BOOKING_URL!=='#';
  const ctaHtml = hasBooking ? '<div class="pc-cta"><span class="pc-cta-label">NEXT STEP</span><h4>この結果で、あなただけのウェディングを。</h4><p>診断カラーをもとに、プロが衣装・前撮り・ヘアメイクをご提案します。</p><a class="lx-btn lx-btn-gold" id="pc-book" href="'+BOOKING_URL+'" target="_blank" rel="noopener">無料で相談・前撮りを予約する</a></div>' : '';
  const swatches=(arr)=>arr.map(h=>`<div class="pc-sw"><span style="background:${h}"></span><small>${h}</small></div>`).join('');
  const confMap={high:['高','#6FA04E'],medium:['中','#D6A85E'],low:['参考','#C57B6A']};
  const [cf,cc]=confMap[r.confidence];
  const notes=r.confNotes&&r.confNotes.length?`<p class="pc-confnote">確からしさに影響した点：${r.confNotes.join('／')}</p>`:'';
  const f=state.features;
  const tone=(v,a,b,c)=> v>=0.3?a : v<=-0.3?c : b;
  const personal=f?`あなたの肌は<b>${f.hueSignal>=0?'黄み寄り':'青み寄り'}</b>・<b>${tone(f.valueSignal,'明るめ','中間の明るさ','暗め')}</b>、肌／髪／瞳のコントラストは<b>${tone(f.contrastSignal,'高め','中間','低め')}</b>。だから ${t.name} の個性を活かすほど、あなたらしさが輝きます。`:'';
  $('#pc-result-body').innerHTML=`
    <div class="pc-res-head" style="--sa:${s.accent}">
      <div class="pc-res-season">${s.emoji} ${s.name} <small>(${s.en})</small></div>
      <h3 class="pc-res-type">${t.name}</h3>
      <p class="pc-res-catch">${t.catch}</p>
      <span class="pc-conf" style="background:${cc}">診断の確からしさ：${cf}</span>
    </div>
    <p class="pc-res-charm">${ex.charm}</p>
    ${personal?`<p class="pc-res-personal">${personal}</p>`:''}
    <p class="pc-res-desc">${t.desc}</p>

    <div class="pc-drape">
      <div class="pc-drape-head">
        <span class="pc-wd-label">VIRTUAL DRAPE</span>
        <h4>自分の肌で採点した色で見比べる</h4>
        <p>あなたの肌データで<b>多数の色を採点</b>し、相性スコア<b>上位＝似合う色</b>／<b>最下位＝苦手な色</b>を表示。下のチップで上位色を見比べられます。</p>
      </div>
      <div class="pc-drape-compare">
        <div class="pc-drape-side">
          <div class="pc-drape-tag good">◎ 似合う色</div>
          <canvas id="pc-drape-good"></canvas>
          <div class="pc-drape-score" id="pc-drape-good-score"></div>
        </div>
        <div class="pc-drape-side">
          <div class="pc-drape-tag bad">△ 苦手な色</div>
          <canvas id="pc-drape-bad"></canvas>
          <div class="pc-drape-score" id="pc-drape-bad-score"></div>
        </div>
      </div>
      <div class="pc-drape-chips" id="pc-drape-chips"></div>
    </div>

    <div class="pc-wedding">
      <img class="pc-wd-mood" src="assets/mood-${t.season}.png" alt="${s.name}のウェディングイメージ" onerror="this.style.display='none'">
      <div class="pc-wedding-head">
        <span class="pc-wd-label">FOR YOUR WEDDING</span>
        <h4>あなたに似合うウェディング</h4>
        <p class="pc-wd-theme">${ex.wd}</p>
      </div>
      <div class="pc-wd-grid">
        <div class="pc-wd-card"><b>👰 ドレス</b><p>${wd.dress}</p></div>
        <div class="pc-wd-card"><b>💐 ブーケ</b><p>${wd.bouquet}</p></div>
        <div class="pc-wd-card"><b>⛪ 会場・装花</b><p>${wd.venue}</p></div>
        <div class="pc-wd-card"><b>💄 花嫁メイク</b><p>${wd.beauty}</p></div>
        <div class="pc-wd-card"><b>💍 アクセサリー</b><p>${wd.accessory}</p></div>
        <div class="pc-wd-card"><b>👘 和装</b><p>${wd.kimono}</p></div>
        <div class="pc-wd-card"><b>📷 前撮りロケ</b><p>${wd.photo}</p></div>
        <div class="pc-wd-card"><b>🥂 二次会ドレス</b><p>${wd.second}</p></div>
        <div class="pc-wd-card"><b>💅 ネイル</b><p>${wd.nail}</p></div>
        <div class="pc-wd-card"><b>🤵 お相手の装い</b><p>${wd.partner}</p></div>
      </div>
    </div>

    <div class="pc-block pc-why"><h4>判定の根拠</h4><ul>${r.reasons.map(x=>`<li>${x}</li>`).join('')}</ul>${notes}</div>

    <div class="pc-block"><h4>似合うベストカラー</h4><div class="pc-sw-grid">${swatches(t.best)}</div></div>
    <div class="pc-block"><h4>避けたい色</h4><div class="pc-sw-grid">${swatches(t.avoid)}</div>
      <p class="pc-tip">苦手な色は「顔から離す（ボトムや小物で使う）」「メイクで血色を足す」と取り入れられます。</p></div>

    <div class="pc-info">
      <div><b>アクセサリー</b>${t.metal}</div>
      <div><b>リップ</b>${t.lip}</div>
      <div><b>髪色</b>${t.hair}</div>
      <div><b>ファッション</b>${t.fashion}</div>
    </div>

    <div class="pc-block pc-second">
      <h4>ブレンドで似合う（2ndタイプ）</h4>
      <div class="pc-second-row"><span>${SEASONS[r.second.season].emoji} ${r.second.name}</span><div class="pc-sw-grid mini">${swatches(r.second.best.slice(0,5))}</div></div>
    </div>

    ${ctaHtml}

    <p class="pc-disclaimer">※ これは写真と問診からの<strong>目安（簡易診断）</strong>です。照明や画面で色は変わります。確定にはプロのドレープ診断をおすすめします。「16タイプ」等は各社の体系・商標とは独立した簡易判定です。</p>
    <div class="pc-actions">
      <button class="lx-btn lx-btn-ghost" id="pc-save">結果を画像で保存</button>
      <button class="lx-btn lx-btn-ghost" id="pc-print">印刷 / PDF</button>
      <button class="lx-btn lx-btn-green" id="pc-restart">もう一度診断する</button>
    </div>
  `;
  $('#pc-print').addEventListener('click',()=>window.print());
  $('#pc-restart').addEventListener('click',restart);
  $('#pc-save').addEventListener('click',()=>makeResultCard(r));
  initDrape(t);
}

// ---- バーチャルドレープ（自分の顔に色を当てる） ----
function shade(hex,amt){ const n=parseInt(hex.slice(1),16); let r=(n>>16)+amt,g=((n>>8)&255)+amt,b=(n&255)+amt; const c=v=>Math.max(0,Math.min(255,v)); return '#'+((1<<24)+(c(r)<<16)+(c(g)<<8)+c(b)).toString(16).slice(1); }
function drawDrapeOn(sel, color){
  const cv=$(sel); if(!cv||!state.imageData) return;
  const W=state.W,H=state.H, lm=state.landmarks;
  const chin = lm&&lm[152]? {x:lm[152].x*W, y:lm[152].y*H} : {x:W/2, y:H*0.6};
  const top = lm&&lm[10]? lm[10].y*H : H*0.2;
  const lj = lm&&lm[234]? lm[234].x*W : W*0.32;
  const rj = lm&&lm[454]? lm[454].x*W : W*0.68;
  const faceW=Math.max(40,Math.abs(rj-lj)), faceH=Math.max(40,chin.y-top);
  const off=document.createElement('canvas'); off.width=W; off.height=H; const ox=off.getContext('2d');
  ox.putImageData(new ImageData(new Uint8ClampedArray(state.imageData),W,H),0,0);
  const y0=chin.y+faceW*0.05;
  ox.save(); ox.beginPath(); ox.rect(0,y0,W,H-y0); ox.ellipse(chin.x,y0,faceW*0.62,faceW*0.5,0,0,Math.PI*2,true);
  const g=ox.createLinearGradient(0,y0,0,H); g.addColorStop(0,color); g.addColorStop(1,shade(color,-14)); ox.fillStyle=g; ox.fill('evenodd'); ox.restore();
  ox.save(); ox.beginPath(); ox.ellipse(chin.x,y0,faceW*0.62,faceW*0.5,0,0,Math.PI*2); ox.strokeStyle='rgba(0,0,0,.13)'; ox.lineWidth=3; ox.stroke(); ox.restore();
  const cropTop=Math.max(0, top-faceH*0.35);
  const cropBot=Math.min(H, chin.y+faceW*1.15);
  const cropW=Math.min(W, faceW*2.1), cropX=Math.max(0, chin.x-cropW/2), cropH=cropBot-cropTop;
  const outW=320, outH=Math.max(40, Math.round(outW*cropH/cropW));
  cv.width=outW; cv.height=outH;
  cv.getContext('2d').drawImage(off, cropX,cropTop,cropW,cropH, 0,0,outW,outH);
}
function hexToRgb(h){ const n=parseInt(h.slice(1),16); return [(n>>16)&255,(n>>8)&255,n&255]; }
// 採点対象の候補色（暖/寒・明/暗・清/濁を広くカバー）
const DRAPE_CANDIDATES=['#FF6F61','#FF7300','#F4C430','#9ACD32','#FFA500','#5C4033','#7B2D26','#556B2F','#C66B3D','#8B3A2B','#6F4E37','#C9A227','#D9A78B','#8A8C5A','#B97A57','#1F4FD8','#E50000','#D6006C','#009B77','#FF1493','#4B0082','#1B1B3A','#6E1423','#01453B','#F4C2C2','#C8A2C8','#B0D9E8','#9E7B9B','#A9D6E5','#E6F0FF','#D87093','#808080'];
// あなたの抽出肌データ(アンダートーン/明度/コントラスト)で、色の相性を"実測"スコア化
function personalScore(hex, t){
  const f=state.features;
  const [r,g,b]=hexToRgb(hex); const c=rgbToLab(r,g,b);
  const C=Math.sqrt(c.a*c.a+c.b*c.b);                                 // 彩度
  const colWarm=c.b-Math.abs(c.a)*0.12;                               // 色の黄み度(warm+)
  const warm = f ? f.hueSignal>=0 : (t.season==='spring'||t.season==='autumn');
  let s=50;
  const warmRaw = warm ? (colWarm-4) : (4-colWarm);
  s += Math.max(-34, Math.min(16, warmRaw))*0.8;                     // 暖/寒（高彩度での上振れをcap）
  const targetL = t.prof.v===2?80 : t.prof.v===0?38 : 60;            // 診断タイプの明度
  s += 20 - Math.abs(c.L-targetL)*0.6;
  const targetC = t.prof.c===2?55 : t.prof.c===0?22 : 38;            // 診断タイプの清濁(彩度)
  s += 18 - Math.abs(C-targetC)*0.45;
  return Math.round(Math.max(10, Math.min(96, s)));
}
function scoreHtml(hex,score){ return `<code>${hex}</code><b>肌との相性 ${score}</b>`; }
function initDrape(t){
  const chips=$('#pc-drape-chips'); if(!chips||!state.imageData) return;
  // 候補色をあなたの肌で採点→ランキング（数字が色の選択を駆動する）
  const pool=[...new Set([...(t.best||[]), ...(t.avoid||[]), ...DRAPE_CANDIDATES])];
  const scored=pool.map(h=>({h, s:personalScore(h,t)})).sort((a,b)=>b.s-a.s);
  const goods=scored.slice(0,6);                 // スコア上位＝あなたに似合う色
  const bad=scored[scored.length-1];             // スコア最下位＝あなたに苦手な色
  drawDrapeOn('#pc-drape-bad', bad.h); $('#pc-drape-bad-score').innerHTML=scoreHtml(bad.h,bad.s);
  const showGood=(o)=>{ drawDrapeOn('#pc-drape-good',o.h); $('#pc-drape-good-score').innerHTML=scoreHtml(o.h,o.s); };
  chips.innerHTML='';
  goods.forEach((o,i)=>{ const btn=document.createElement('button'); btn.className='pc-drape-chip'+(i===0?' on':''); btn.style.background=o.h; btn.title=o.h+' / 相性'+o.s; btn.addEventListener('click',()=>{ showGood(o); [...chips.children].forEach(c=>c.classList.remove('on')); btn.classList.add('on'); }); chips.appendChild(btn); });
  showGood(goods[0]);
}

function restart(){
  state.features=null; state.loaded=false; state.wbSet=false; state.wb={r:1,g:1,b:1};
  $('#pc-file').value='';
  $('#pc-preview').hidden=true; $('#pc-extracted').hidden=true; $('#pc-after-upload').hidden=true; $('#pc-warn').hidden=true;
  $('#pc-questions').hidden=true; $('#pc-result').hidden=true;
  setStatus('明るい自然光・正面・ノーメイク〜薄めがおすすめです。');
  $('#start').scrollIntoView({behavior:'smooth',block:'start'});
}

// ---- 結果を画像カードとして保存（シェア用） ----
function roundRect(x,X,Y,w,h,r){ x.beginPath(); x.moveTo(X+r,Y); x.arcTo(X+w,Y,X+w,Y+h,r); x.arcTo(X+w,Y+h,X,Y+h,r); x.arcTo(X,Y+h,X,Y,r); x.arcTo(X,Y,X+w,Y,r); x.closePath(); }
function wrapText(x,text,cx,y,maxW,lh){ let line='',yy=y; for(const c of [...text]){ if(x.measureText(line+c).width>maxW){ x.fillText(line,cx,yy); line=c; yy+=lh; } else line+=c; } x.fillText(line,cx,yy); return yy; }
function makeResultCard(r){
  try{
    const t=r.first, s=SEASONS[t.season], ex=TYPE_EXTRA[t.id]||{};
    const W=720,H=1180, cv=document.createElement('canvas'); cv.width=W; cv.height=H;
    const x=cv.getContext('2d');
    const render=()=>{
      x.textAlign='center';
      x.fillStyle='#C98A7C'; x.font='600 24px Georgia,serif'; x.fillText('FOR YOUR WEDDING', W/2, 540);
      x.fillStyle='#9E927E'; x.font='15px sans-serif'; x.fillText(s.name+'  /  '+s.en, W/2, 580);
      x.fillStyle='#473F36'; x.font='700 44px Georgia,serif'; x.fillText(t.name, W/2, 636);
      x.fillStyle='#C98A7C'; x.font='italic 20px Georgia,serif'; x.fillText(t.catch||'', W/2, 674);
      x.fillStyle='#5C6E58'; x.font='17px sans-serif'; wrapText(x, ex.wd||'', W/2, 724, 600, 26);
      const cols=t.best.slice(0,6), sw=80, gap=14, total=cols.length*sw+(cols.length-1)*gap; let sx=(W-total)/2;
      cols.forEach(h=>{ x.fillStyle=h; roundRect(x,sx,860,sw,sw,12); x.fill(); sx+=sw+gap; });
      x.fillStyle='#9E927E'; x.font='13px sans-serif'; x.fillText('Coloria Atelier ｜ AI Personal Color', W/2, 1110);
      cv.toBlob(b=>{ if(!b){ window.print(); return; } const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='personal-color-'+t.id+'.png'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1500); }, 'image/png');
    };
    x.fillStyle='#FBF7F1'; x.fillRect(0,0,W,H);
    const img=new Image();
    img.onload=()=>{ const bandH=470, ar=img.width/img.height; let dw=W, dh=W/ar; if(dh<bandH){ dh=bandH; dw=bandH*ar; } x.save(); x.beginPath(); x.rect(0,0,W,bandH); x.clip(); x.drawImage(img,(W-dw)/2,(bandH-dh)/2,dw,dh); x.restore(); render(); };
    img.onerror=render;
    img.src='assets/mood-'+t.season+'.png';
  }catch(err){ console.error(err); window.print(); }
}
