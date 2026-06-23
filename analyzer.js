// ===================================================================
// 顔写真の色抽出 v2（MediaPipe Face Landmarker 478点 前提）
// 出典: _knowledge/03。CIELab主軸。WBは白タップ補正。
// v2: 撮影品質チェック(顔サイズ/露出/左右差)・髪/瞳の信頼度判定を追加。
// ※ しきい値は近似（要・実データ較正）。CALIB で調整。
// ===================================================================

// しきい値は色彩科学の公開値ベース（_knowledge/03・OpenOximetry/NIST）。"勘の数値"を排除。
export const CALIB = {
  // 明度: ITA°(Individual Typology Angle)の公開バンド。light境界=41° / deep境界=28°
  //   参考: >55 very light /41-55 light /28-41 intermediate /10-28 tan /<10 brown-dark
  ITA_LIGHT: 41,
  ITA_DEEP: 28,
  // アンダートーン: CIELab b*(黄-青)が暖寒の主軸。絶対カットオフは未確立のため
  //   一般的な肌b*中央(≈16)からの相対で見る（WB補正時のみ信頼／diagnosis側でWB未設定は減点）
  SKIN_B_NEUTRAL: 16,
  // 彩度(清濁の補助・弱信号): 一般的な肌C*中央付近
  SKIN_C_MID: 18,
  // コントラスト(肌-髪/瞳のL*差・Weber的): 文献の確定カットオフなし→経験則として残置
  CONTRAST_MID: 34,
  // 撮影品質チェック
  FACE_MIN_W: 0.16,   // 画像幅に対する顔幅 これ未満=顔が小さい
  EXPOSE_HI: 90,      // 肌L* これ以上=白とび疑い
  EXPOSE_LO: 30,      // 肌L* これ以下=暗すぎ
  HAIR_BG_L: 88,      // 髪L* これ以上=背景混入疑い(髪として不採用)
};

export const REGIONS = {
  cheekL: [50,116,117,118,119,123,205,206,207],
  cheekR: [280,345,346,347,348,352,425,426,427],
  forehead: [10,9,151,67,69,108,299,332,337],
  irisL: [468,469,470,471,472],
  irisR: [473,474,475,476,477],
};

// ---------- 色変換 ----------
function srgbToLinear(c){ c/=255; return c<=0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4); }
export function rgbToLab(r,g,b){
  const R=srgbToLinear(r),G=srgbToLinear(g),B=srgbToLinear(b);
  let X=R*0.4124+G*0.3576+B*0.1805, Y=R*0.2126+G*0.7152+B*0.0722, Z=R*0.0193+G*0.1192+B*0.9505;
  X/=0.95047; Z/=1.08883;
  const f=t=> t>0.008856 ? Math.cbrt(t) : (7.787*t+16/116);
  const fx=f(X),fy=f(Y),fz=f(Z);
  return { L:116*fy-16, a:500*(fx-fy), b:200*(fy-fz) };
}
export function labMeta(lab){
  const C=Math.sqrt(lab.a*lab.a+lab.b*lab.b);
  const ITA=Math.atan2(lab.L-50, lab.b)*180/Math.PI;
  return { ...lab, C, ITA };
}

function median(arr){ const s=[...arr].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2? s[m] : (s[m-1]+s[m])/2; }
function clamp255(v){ return Math.max(0,Math.min(255,v)); }

function samplePoints(lms, idxs, data, W, H, wb, patch=2){
  const rs=[],gs=[],bs=[];
  for(const i of idxs){
    const lm=lms[i]; if(!lm) continue;
    const px=Math.round(lm.x*W), py=Math.round(lm.y*H);
    for(let dy=-patch;dy<=patch;dy++) for(let dx=-patch;dx<=patch;dx++){
      const x=px+dx, y=py+dy; if(x<0||y<0||x>=W||y>=H) continue;
      const o=(y*W+x)*4;
      rs.push(data[o]*wb.r); gs.push(data[o+1]*wb.g); bs.push(data[o+2]*wb.b);
    }
  }
  if(!rs.length) return null;
  return { r:clamp255(median(rs)), g:clamp255(median(gs)), b:clamp255(median(bs)) };
}

function sampleHair(lms, data, W, H, wb){
  const top=lms[10], chin=lms[152];
  if(!top||!chin) return null;
  const faceH=Math.abs(chin.y-top.y);
  const rs=[],gs=[],bs=[];
  for(const f of [0.10,0.16,0.22]){
    const x=Math.round(top.x*W), y=Math.round((top.y-faceH*f)*H);
    if(x<0||y<2||x>=W||y>=H) continue;
    for(let dy=-3;dy<=3;dy++) for(let dx=-6;dx<=6;dx++){
      const xx=x+dx, yy=y+dy; if(xx<0||yy<0||xx>=W||yy>=H) continue;
      const o=(yy*W+xx)*4; rs.push(data[o]*wb.r); gs.push(data[o+1]*wb.g); bs.push(data[o+2]*wb.b);
    }
  }
  if(!rs.length) return null;
  return { r:clamp255(median(rs)), g:clamp255(median(gs)), b:clamp255(median(bs)) };
}

function faceBox(lms){
  let minx=1,miny=1,maxx=0,maxy=0;
  for(const lm of lms){ if(lm.x<minx)minx=lm.x; if(lm.x>maxx)maxx=lm.x; if(lm.y<miny)miny=lm.y; if(lm.y>maxy)maxy=lm.y; }
  return { w:maxx-minx, h:maxy-miny, cx:(minx+maxx)/2 };
}

export function extractFeatures(lms, data, W, H, wb={r:1,g:1,b:1}){
  const box=faceBox(lms);
  const skinRGBs=[
    samplePoints(lms, REGIONS.cheekL, data, W, H, wb),
    samplePoints(lms, REGIONS.cheekR, data, W, H, wb),
    samplePoints(lms, REGIONS.forehead, data, W, H, wb, 2),
  ].filter(Boolean);
  if(!skinRGBs.length) return null;
  const skinRGB={ r:median(skinRGBs.map(s=>s.r)), g:median(skinRGBs.map(s=>s.g)), b:median(skinRGBs.map(s=>s.b)) };
  const skin=labMeta(rgbToLab(skinRGB.r,skinRGB.g,skinRGB.b));

  const irisRGB = samplePoints(lms, REGIONS.irisL, data, W, H, wb, 1) || samplePoints(lms, REGIONS.irisR, data, W, H, wb, 1);
  let eye = irisRGB ? labMeta(rgbToLab(irisRGB.r,irisRGB.g,irisRGB.b)) : null;
  const hairRGB = sampleHair(lms, data, W, H, wb);
  let hair = hairRGB ? labMeta(rgbToLab(hairRGB.r,hairRGB.g,hairRGB.b)) : null;

  // 信頼性: 髪が明るすぎ=背景混入 / 瞳は肌より暗いはず
  const hairReliable = hair && hair.L < CALIB.HAIR_BG_L && Math.abs(hair.L-skin.L) > 3;
  const eyeReliable  = eye && eye.L < skin.L + 5;
  if(!hairReliable) hair=hair?{...hair,unreliable:true}:null;
  if(!eyeReliable)  eye=eye?{...eye,unreliable:true}:null;

  const lr = (skinRGBs[0]&&skinRGBs[1]) ? Math.abs(rgbToLab(skinRGBs[0].r,skinRGBs[0].g,skinRGBs[0].b).L - rgbToLab(skinRGBs[1].r,skinRGBs[1].g,skinRGBs[1].b).L) : 0;

  const cHair = hairReliable ? Math.abs(skin.L-hair.L) : 0;
  const cEye  = eyeReliable  ? Math.abs(skin.L-eye.L)  : 0;
  const contrast = Math.max(cHair, cEye);

  // 撮影品質
  const warnings=[];
  if(box.w < CALIB.FACE_MIN_W) warnings.push('顔が小さめ（近づいて撮ると精度UP）');
  if(skin.L > CALIB.EXPOSE_HI) warnings.push('明るすぎ（白とび気味）');
  if(skin.L < CALIB.EXPOSE_LO) warnings.push('暗すぎ');
  if(lr > 12) warnings.push('顔の左右で明るさ差が大きい（照明ムラ）');
  if(!hairReliable && !eyeReliable) warnings.push('髪・瞳の色が取りにくい（コントラスト判定は弱め）');

  const cl=(v)=>Math.max(-1,Math.min(1,v));
  return {
    skinRGB, skin, eye, hair, contrast, lrDiff: lr, box,
    quality: { ok: warnings.length===0, warnings },
    // 明度=ITAバンド基準（light境界41°/deep境界28°を ±0.5 に対応させ連続化）
    valueSignal: cl((skin.ITA - (CALIB.ITA_LIGHT+CALIB.ITA_DEEP)/2) / ((CALIB.ITA_LIGHT-CALIB.ITA_DEEP))),
    // 暖寒=b*（肌b*中央からの相対・WB補正時のみ信頼）
    hueSignal:   cl((skin.b - CALIB.SKIN_B_NEUTRAL)/12),
    chromaSignal:cl((skin.C - CALIB.SKIN_C_MID)/10),
    contrastSignal: contrast>0 ? cl((contrast - CALIB.CONTRAST_MID)/22) : 0,
  };
}

export function computeWB(r,g,b){
  const target=Math.max(r,g,b,1);
  return { r:target/Math.max(r,1), g:target/Math.max(g,1), b:target/Math.max(b,1) };
}
