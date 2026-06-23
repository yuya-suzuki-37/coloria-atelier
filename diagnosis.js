// ===================================================================
// 判定ロジック v2: 写真特徴 ＋ 問診 → 4シーズン → 16タイプ
// 出典: _knowledge/02・06。写真=Value/Contrast主導, 問診=Hue/Chroma主導。
// v2: WB未設定時は写真の色みを減点 / 判定根拠(reasons)を返す / 信頼度を精緻化
// ===================================================================
import { TYPES, SEASONS } from './data.js';

const SEASON_KEYS=['spring','summer','autumn','winter'];

export function diagnose(photo, answers, wbSet=false){
  const season={ spring:0, summer:0, autumn:0, winter:0 };
  let hueAx=0, valAx=0, chrAx=0, conAx=0;
  const reasons=[];

  // --- 問診 ---
  let qSeasonVotes=0;
  for(const a of (answers||[])){
    if(!a) continue;
    if(a.s){ season[a.s]+=2; qSeasonVotes++; }
    if(a.hue) hueAx+=a.hue;
    if(a.v)   valAx+=a.v;
    if(a.c)   chrAx+=a.c;
    if(a.k)   conAx+=a.k;
  }

  // --- 写真 ---
  let photoSeasonGuess=null;
  if(photo){
    // WB未設定だと色み(hue)・彩度(chroma)は信頼できない → 大幅減点
    const hueW   = wbSet ? 1.0 : 0.3;
    const h=photo.hueSignal*hueW, v=photo.valueSignal;
    if(h>=0){ season.spring+=h*2; season.autumn+=h*2; } else { season.summer+=(-h)*2; season.winter+=(-h)*2; }
    if(v>=0){ season.spring+=v*1.5; season.summer+=v*1.5; } else { season.autumn+=(-v)*1.5; season.winter+=(-v)*1.5; }
    // 軸: 写真はValue/Contrastに強く, Hue/Chromaは弱め(WBでさらに調整)
    hueAx += h*1.2; valAx += v*2.2; chrAx += photo.chromaSignal*(wbSet?1.0:0.4); conAx += photo.contrastSignal*2.2;
    const warm=photo.hueSignal>=0, light=v>=0;
    photoSeasonGuess = warm ? (light?'spring':'autumn') : (light?'summer':'winter');

    reasons.push(`肌のアンダートーンは${photo.hueSignal>=0?'黄み寄り(イエベ傾向)':'青み寄り(ブルベ傾向)'}${wbSet?'':'（※白タップ未設定のため参考値）'}`);
    reasons.push(`肌の明度は${v>=0.3?'明るめ':v<=-0.3?'暗め':'中間'}、コントラストは${photo.contrastSignal>=0.3?'高め':photo.contrastSignal<=-0.3?'低め':'中間'}`);
  } else {
    reasons.push('写真なし（問診のみ）で判定しています');
  }

  // --- トップシーズン ---
  const sorted=SEASON_KEYS.slice().sort((a,b)=>season[b]-season[a]);
  const topSeason=sorted[0];
  const seasonMargin=season[sorted[0]]-season[sorted[1]];
  reasons.push(`総合で最も得点が高いのは「${SEASONS[topSeason].name}」（2位「${SEASONS[sorted[1]].name}」との差 ${seasonMargin.toFixed(1)}）`);

  // --- 軸レベル化（2/1/0） ---
  const lvl=(x,hi,lo)=> x>=hi?2 : x<=lo?0 : 1;
  const V=lvl(valAx,1.2,-1.2), C=lvl(chrAx,0.8,-0.8), K=lvl(conAx,1.2,-1.2);

  // --- 全16タイプを グローバルスコア化（season得点 + 軸マッチ） ---
  const ranked=TYPES.map(t=>{
    const dist=Math.abs(t.prof.v-V)+Math.abs(t.prof.c-C)+Math.abs(t.prof.k-K);
    const matchBonus=(6-dist)/6*2.5;
    return { type:t, score: season[t.season] + matchBonus, dist };
  }).sort((a,b)=>b.score-a.score);

  const first=ranked[0].type;
  const second=(ranked.find(r=>r.type.id!==first.id)||ranked[1]).type;

  // --- 信頼度 ---
  let conf=0; const cReasons=[];
  if(seasonMargin>=4){ conf++; } else { cReasons.push('シーズン間の差が小さい'); }
  if(photo && photoSeasonGuess===topSeason){ conf++; } else if(photo){ cReasons.push('写真と問診の傾向にズレ'); }
  if(wbSet){ conf++; } else { cReasons.push('ホワイトバランス未補正'); }
  if(!photo){ conf--; cReasons.push('写真なし'); }
  if(photo && photo.lrDiff>10){ conf--; cReasons.push('顔の左右で明るさ差が大きい(照明ムラ)'); }
  if(photo && photo.quality && photo.quality.warnings.length){ conf--; cReasons.push(...photo.quality.warnings); }
  if(qSeasonVotes<8){ cReasons.push('未回答の質問が多い'); }
  const confidence = conf>=2 ? 'high' : conf>=1 ? 'medium' : 'low';

  return {
    first, second,
    season: topSeason, seasonName: SEASONS[topSeason].name,
    scores: season,
    axes: { value:V, chroma:C, contrast:K, hue: hueAx>=0?'warm':'cool' },
    photoSeasonGuess, confidence, confNotes:cReasons, reasons,
    agree: photo ? (photoSeasonGuess===topSeason) : null,
  };
}
