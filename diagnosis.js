// ===================================================================
// 判定ロジック v3: 写真特徴 ＋ 問診 → 4軸ベクトル → 16タイプ連続採点
// 出典: _knowledge/02・06。
// 設計の核:
//  1) 4軸(暖寒hue/明度v/清濁c/コントラストk)を「写真×問診の軸別ブレンド」で算出。
//     写真は Value/Contrast に強い→高重み, Hue/Chroma は照明依存→WB次第で問診主体。
//  2) 16タイプを軸ベクトルとの連続距離で採点（v2の「同シーズン4タイプ同点」問題を解消）。
//  3) シーズン投票・写真シーズン推定はボーナス（プライア）として加算。
//  4) 根拠は軸ごと＋出所(写真/問診)を明示して正直に提示。
// ※ しきい値は文献値ベースの近似。最終精度は実写真較正で詰める（calibration mode予定）。
// ===================================================================
import { TYPES, SEASONS } from './data.js?v=2';

const SEASON_KEYS=['spring','summer','autumn','winter'];
const clamp=(v,lo=-1,hi=1)=>Math.max(lo,Math.min(hi,v));

export function diagnose(photo, answers, wbMode=false){
  // WBモード: 'manual'(白タップ・最信頼) / 'auto'(白目自動・中信頼) / false(未補正)
  const wbSet=!!wbMode, wbManual=wbMode==='manual', wbAuto=wbMode==='auto';

  // ---------- 1) 問診 → 軸平均(各 -1..+1) ＋ シーズン投票 ----------
  const qSum={hue:0,v:0,c:0,k:0}, qCnt={hue:0,v:0,c:0,k:0};
  const qSeason={spring:0,summer:0,autumn:0,winter:0};
  let qSeasonVotes=0;
  for(const a of (answers||[])){
    if(!a) continue;
    if(a.s){ qSeason[a.s]++; qSeasonVotes++; }
    if(typeof a.hue==='number'){ qSum.hue+=a.hue; qCnt.hue++; }
    if(typeof a.v  ==='number'){ qSum.v  +=a.v;   qCnt.v++; }
    if(typeof a.c  ==='number'){ qSum.c  +=a.c;   qCnt.c++; }
    if(typeof a.k  ==='number'){ qSum.k  +=a.k;   qCnt.k++; }
  }
  const qAvg=k=> qCnt[k] ? clamp(qSum[k]/qCnt[k]) : 0;
  const qHue=qAvg('hue'), qVal=qAvg('v'), qChr=qAvg('c'), qCon=qAvg('k');
  const totalVotes=Math.max(qSeasonVotes,1);
  const qSeasonShare={}; for(const s of SEASON_KEYS) qSeasonShare[s]=qSeason[s]/totalVotes;

  // ---------- 2) 写真 ＋ 問診を軸別ブレンド ----------
  const has=!!photo;
  const pHue = has ? photo.hueSignal : 0;
  const pVal = has ? photo.valueSignal : 0;
  const pChr = has ? photo.chromaSignal : 0;
  const pCon = has ? (photo.contrastSignal||0) : 0;
  const conReliable = has && Math.abs(pCon) > 1e-6; // 髪・瞳が取れてコントラスト算出できたか

  // 軸別 写真重み（残りは問診）。文献: 明度/コントラストは写真が強い, 暖寒/清濁はWB次第。
  const wPhoto={
    v:  has ? 0.68 : 0,                 // 明度: 写真主導(ITAは信頼できる)
    k:  conReliable ? 0.60 : 0,         // コントラスト: 取得できた時のみ写真主導
    hue:has ? (wbManual?0.45 : wbAuto?0.33 : 0.15) : 0, // 暖寒: 手動>自動>未補正
    c:  has ? (wbManual?0.48 : wbAuto?0.36 : 0.20) : 0, // 清濁: 手動>自動>未補正
  };
  const blend=(p,q,w)=> clamp(w*p + (1-w)*q);
  const AX={
    hue: blend(pHue,qHue,wPhoto.hue),
    v:   blend(pVal,qVal,wPhoto.v),
    c:   blend(pChr,qChr,wPhoto.c),
    k:   blend(pCon,qCon,wPhoto.k),
  };
  const photoSeasonGuess = has
    ? ((pHue>=0) ? (pVal>=0?'spring':'autumn') : (pVal>=0?'summer':'winter'))
    : null;

  // ---------- 3) 16タイプ 連続距離採点 ----------
  // 実信号は中央寄りに圧縮されるため、距離評価ではゲインで端(±1)へ伸張しプロファイル(0/1/2)と整合。
  const G=1.5;
  const axg={ hue:clamp(AX.hue*G), v:clamp(AX.v*G), c:clamp(AX.c*G), k:clamp(AX.k*G) };
  const cen=x=> x-1;                                   // prof 0/1/2 → -1/0/+1
  const hueTarget=t=> (t.season==='spring'||t.season==='autumn') ? 1 : -1; // warm/cool
  const W={hue:1.35, v:1.15, c:1.0, k:1.0};
  const maxDist=(W.hue+W.v+W.c+W.k)*2;                 // 各|差|の上限=2
  const ranked=TYPES.map(t=>{
    const d = W.hue*Math.abs(axg.hue - hueTarget(t))
            + W.v  *Math.abs(axg.v   - cen(t.prof.v))
            + W.c  *Math.abs(axg.c   - cen(t.prof.c))
            + W.k  *Math.abs(axg.k   - cen(t.prof.k));
    const axisScore=(maxDist-d)/maxDist;               // 0..1（近いほど高）
    const seasonBonus = 0.5*qSeasonShare[t.season] + (photoSeasonGuess===t.season?0.12:0);
    return { type:t, score: axisScore+seasonBonus, axisScore, d };
  }).sort((a,b)=>b.score-a.score);

  const first=ranked[0].type;
  const second=(ranked.find(r=>r.type.id!==first.id)||ranked[1]).type;
  const topMargin=ranked[0].score-ranked[1].score;

  // シーズン得点（各シーズンの最良タイプ得点）
  const season={spring:-9,summer:-9,autumn:-9,winter:-9};
  for(const r of ranked){ if(r.score>season[r.type.season]) season[r.type.season]=r.score; }
  const seasonSorted=SEASON_KEYS.slice().sort((a,b)=>season[b]-season[a]);
  const topSeason=first.season;
  const seasonMargin=season[seasonSorted[0]]-season[seasonSorted[1]];

  // ---------- 4) 根拠（軸ごと＋出所） ----------
  const reasons=[];
  const dir=(x,hi,lo,mid)=> x>=0.34?hi : x<=-0.34?lo : mid;
  if(has){
    reasons.push(`明度（明るさ）：${dir(AX.v,'明るめ','暗め','中間')}（写真主体）`);
    reasons.push(`コントラスト（肌・髪・瞳の差）：${dir(AX.k,'高め','低め','中間')}（${conReliable?'写真主体':'髪/瞳が取りにくく問診主体'}）`);
    reasons.push(`アンダートーン（暖寒）：${AX.hue>=0?'黄み寄り(イエベ傾向)':'青み寄り(ブルベ傾向)'}（${wbManual?'白タップ補正あり' : wbAuto?'自動WB(白目基準・参考)' : '白タップ未設定のため問診主体・参考値'}）`);
    reasons.push(`清濁（クリア/くすみ）：${dir(AX.c,'クリア寄り','くすみ寄り','中間')}（${wbSet?'写真+問診':'問診主体'}）`);
  } else {
    reasons.push('写真なし・問診のみで判定しています（写真があると明度・コントラストの精度が上がります）');
  }
  reasons.push(`最も近いシーズンは「${SEASONS[topSeason].name}」（2位シーズンとの差 ${seasonMargin.toFixed(2)}）。タイプは1位「${first.name}」／2位「${second.name}」（差 ${topMargin.toFixed(2)}）`);

  // ---------- 5) 信頼度 ----------
  let conf=0; const cReasons=[];
  if(topMargin>=0.10){ conf++; } else { cReasons.push('1位と2位のタイプが僅差'); }
  if(has && photoSeasonGuess===topSeason){ conf++; }
  else if(has){ conf--; cReasons.push('写真と問診でシーズン傾向にズレ'); }
  if(wbManual){ conf++; }
  else if(wbAuto){ conf++; cReasons.push('ホワイトバランスは自動推定（白目基準・参考値）'); }
  else { cReasons.push('ホワイトバランス未補正（暖寒は問診主体）'); }
  if(!has){ conf--; cReasons.push('写真なし'); }
  if(has && photo.lrDiff>10){ conf--; cReasons.push('顔の左右で明るさ差が大きい(照明ムラ)'); }
  if(has && photo.quality && photo.quality.warnings.length){ conf--; cReasons.push(...photo.quality.warnings); }
  if(qSeasonVotes<8){ cReasons.push('未回答の質問が多い'); }
  const confidence = conf>=2 ? 'high' : conf>=1 ? 'medium' : 'low';

  // 軸レベル化（表示用 2/1/0）
  const lvl=x=> x>=0.34?2 : x<=-0.34?0 : 1;
  return {
    first, second,
    season: topSeason, seasonName: SEASONS[topSeason].name,
    scores: season,
    axes: { value:lvl(AX.v), chroma:lvl(AX.c), contrast:lvl(AX.k), hue: AX.hue>=0?'warm':'cool' },
    axisDetail: AX,
    photoSeasonGuess, confidence, confNotes:cReasons, reasons,
    agree: has ? (photoSeasonGuess===topSeason) : null,
  };
}
