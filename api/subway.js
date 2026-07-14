// /api/subway.js
// Vercel Serverless Function
//
// 서울 열린데이터광장 "지하철 실시간 도착정보(realtimeStationArrival)" API를 이용해
// 9호선 38개 역의 도착정보를 모두 모은 뒤, 같은 열차(trainNo)가 여러 역에 걸쳐
// 중복으로 잡히는 것 중 "가장 가까운 도착 예정"인 레코드를 골라 위치를 역추론합니다.
//
// 서울시 공식 안내:
//   recptnDt(데이터 생성시각)와 현재시각의 차이만큼 열차가 더 진행한 것으로
//   보정해서 사용해야 함. (예: 현재 10:05:30, recptnDt 10:03:30 → 2분 보정)
// 이 보정을 effEta 계산에 반영했고, 각 역별 시차(lagSec)를 diagnostics로 노출해서
// "현재 시간과 열차 데이터가 맞는지"를 직접 확인할 수 있게 했습니다.
//
// 필요한 환경변수 (Vercel 프로젝트 설정 > Environment Variables):
//   SEOUL_SUBWAY_API_KEY = 서울 열린데이터광장에서 발급받은 "실시간 지하철 인증키"
//
// 주의: 이 API는 환승역의 경우 해당 역을 지나는 다른 호선 열차 정보도 함께 반환하므로
// subwayId / trainLineNm 기준으로 9호선만 필터링합니다.
 
const SEOUL_API_KEY = process.env.SEOUL_SUBWAY_API_KEY;
 
const STATIONS = [
  '개화', '김포공항', '공항시장', '신방화', '마곡나루', '양천향교', '가양', '증미', '등촌',
  '염창', '신목동', '선유도', '당산', '국회의사당', '여의도', '샛강', '노량진', '노들',
  '흑석', '동작', '구반포', '신반포', '고속터미널', '사평', '신논현', '언주', '선정릉',
  '삼성중앙', '봉은사', '종합운동장', '삼전', '석촌고분', '석촌', '송파나루', '한성백제',
  '올림픽공원', '둔촌오륜', '중앙보훈병원'
];
 
// 역간 평균 소요시간(초) — 실제 운행 데이터에 맞춰 조정 필요할 수 있음
const AVG_SEGMENT_SEC = 120;
 
// 이 값보다 recptnDt 시차가 크면 "데이터 지연" 경고
const LAG_WARN_THRESHOLD_SEC = 300;
 
function nowEpochSeconds() {
  // recptnDt 파싱 시 이미 '+09:00'을 붙여 절대 UTC epoch으로 변환하므로,
  // 여기서는 순수 UTC epoch만 반환하면 된다 (9시간을 또 더하면 이중 보정 버그가 생김).
  return Math.floor(Date.now() / 1000);
}
 
// "2026-07-14 15:23:10" (서울시 API는 TZ 표기 없이 KST 기준 문자열을 줌)
function parseRecptnDt(str) {
  if (!str) return null;
  const t = new Date(str.replace(' ', 'T') + '+09:00').getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
 
async function fetchStation(stationName) {
  const url = `http://swopenapi.seoul.go.kr/api/subway/${SEOUL_API_KEY}/json/realtimeStationArrival/0/20/${encodeURIComponent(stationName)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // DEBUG: 여기서는 절대 throw하지 않고 원본 data를 그대로 넘겨서
    // errorMessage 노드의 실제 내용을 응답에서 확인할 수 있게 한다.
    return { list: data.realtimeArrivalList || [], raw: data };
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}
 
function isLine9(row) {
  const tag = `${row.subwayId || ''} ${row.trainLineNm || ''}`;
  return tag.includes('9호선') || row.subwayId === '1009' || row.subwayId === '1092';
}
 
module.exports = async (req, res) => {
  if (!SEOUL_API_KEY) {
    res.status(200).json({
      trains: [],
      error: 'SEOUL_SUBWAY_API_KEY 환경변수가 설정되지 않았습니다.'
    });
    return;
  }
 
  const nowSec = nowEpochSeconds();
  const settled = await Promise.allSettled(STATIONS.map(fetchStation));
 
  const perTrain = new Map(); // trainNo -> 가장 가까운 도착 레코드
  const diagnostics = [];
  let failCount = 0;
  let debugSample = null; // 첫 번째 역의 서울시 원본 응답 (문제 진단용)
 
  settled.forEach((r, idx) => {
    const stationName = STATIONS[idx];
 
    if (r.status !== 'fulfilled') {
      failCount++;
      diagnostics.push({ station: stationName, ok: false, error: r.reason?.message || 'unknown error' });
      return;
    }
 
    const { list, raw } = r.value;
    const rows = list.filter(isLine9);
 
    if (!debugSample) {
      debugSample = {
        station: stationName,
        rawErrorMessage: raw.errorMessage || null,
        rawListLength: list.length,
        afterLine9FilterLength: rows.length,
        firstRawRow: list[0] || null
      };
    }
 
    const sampleLag = rows[0] ? (() => {
      const rt = parseRecptnDt(rows[0].recptnDt);
      return rt ? nowSec - rt : null;
    })() : null;
 
    diagnostics.push({ station: stationName, ok: true, rawCount: list.length, count: rows.length, lagSec: sampleLag });
 
    rows.forEach(row => {
      const trainNo = row.btrainNo || row.trainNo;
      const eta = parseInt(row.barvlDt, 10);
      if (!trainNo || Number.isNaN(eta)) return;
 
      const recTime = parseRecptnDt(row.recptnDt);
      const lag = recTime ? Math.max(0, nowSec - recTime) : 0;
      // 서울시 안내대로 시차만큼 보정: 실제 남은 시간 = 원래 ETA - 데이터 지연시간
      const effEta = Math.max(0, eta - lag);
 
      const existing = perTrain.get(trainNo);
      if (!existing || effEta < existing.effEta) {
        perTrain.set(trainNo, {
          trainNo,
          stationIdx: idx,
          dir: row.updnLine === '상행' ? 'up' : 'down',
          express: (row.btrainSttus || '').includes('급행') || (row.trainLineNm || '').includes('급행'),
          effEta,
          lag
        });
      }
    });
  });
 
  const trains = [];
  perTrain.forEach(t => {
    const frac = Math.max(0, Math.min(1, t.effEta / AVG_SEGMENT_SEC));
    // dir='up' → 역 인덱스가 커지는 방향으로 이동한다고 가정 (기존 프론트 시뮬레이션과 동일 규칙)
    // 실제 서울시 데이터의 상행/하행 라벨과 방향이 반대로 보이면 이 부호를 뒤집어야 함
    const pos = t.dir === 'up' ? t.stationIdx - frac : t.stationIdx + frac;
    trains.push({
      id: t.trainNo,
      num: t.trainNo,
      dir: t.dir,
      pos: Math.max(0, Math.min(STATIONS.length - 1, pos)),
      express: t.express,
      etaToNextStationSec: t.effEta,
      dataLagSec: t.lag
    });
  });
 
  const maxLag = diagnostics.reduce((m, d) => (d.lagSec != null && d.lagSec > m ? d.lagSec : m), 0);
  let warning = '';
  if (failCount > STATIONS.length / 2) {
    warning = `${failCount}/${STATIONS.length}개 역 조회 실패 — API 키 또는 요청 한도를 확인하세요.`;
  } else if (maxLag > LAG_WARN_THRESHOLD_SEC) {
    warning = `데이터 지연 ${maxLag}초 감지 — 서울시 원본 데이터가 지연되고 있을 수 있습니다.`;
  }
 
  res.status(200).json({
    trains,
    warning,
    serverTimeUTC: new Date(nowSec * 1000).toISOString(),
    serverTimeKST: new Date(nowSec * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    debugSample, // 문제 진단 후에는 이 필드는 지워도 됨
    diagnostics // 역별 recptnDt 시차 — 이 값으로 "현재시간과 열차 데이터가 맞는지" 직접 확인 가능
  });
};
 
