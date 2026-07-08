// api/subway.js — Vercel Serverless Function (region: icn1 서울)
//
// 진단 결과: swopenapi.seoul.go.kr 서버가 Vercel(클라우드) IP 대역을
// 방화벽에서 차단하고 있음 (ETIMEDOUT — TCP 연결 자체가 응답 없이 버려짐)
// → 직접 연결이 원천적으로 불가능하므로, 공개 프록시 서버를 경유해서 우회 요청
 
const STATIONS = [
  '개화','김포공항','공항시장','신방화','마곡나루','양천향교',
  '가양','증미','등촌','염창','신목동','선유도',
  '당산','국회의사당','여의도','샛강','노량진','노들',
  '흑석','동작','구반포','신반포','고속터미널','사평',
  '신논현','언주','선정릉','삼성중앙','봉은사','종합운동장',
  '삼전','석촌고분','석촌','송파나루','한성백제','올림픽공원',
  '둔촌오륜','중앙보훈병원'
];
 
const DIRECT_TIMEOUT_MS = 3000;   // 직접 연결은 어차피 막혀있으니 빨리 포기
const PROXY_TIMEOUT_MS = 9000;
 
// 우회용 공개 프록시 (순서대로 시도)
const PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];
 
function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
 
// 직접 연결 시도 → 실패하면 프록시 순서대로 시도
async function fetchViaProxyChain(targetUrl) {
  const attempts = [];
 
  // 1) 직접 연결 (거의 항상 실패하지만 혹시 해제됐을 수 있으니 짧게 시도)
  try {
    const r = await fetchWithTimeout(targetUrl, DIRECT_TIMEOUT_MS);
    const body = await r.text();
    attempts.push({ method: 'direct', ok: true, status: r.status });
    return { body, via: 'direct', attempts };
  } catch (e) {
    attempts.push({ method: 'direct', ok: false, error: e.message });
  }
 
  // 2) 프록시 체인 순서대로 시도
  for (const buildUrl of PROXIES) {
    const proxyUrl = buildUrl(targetUrl);
    try {
      const r = await fetchWithTimeout(proxyUrl, PROXY_TIMEOUT_MS);
      const body = await r.text();
      if (r.ok && body && body.length > 10) {
        attempts.push({ method: proxyUrl.split('/')[2], ok: true, status: r.status });
        return { body, via: proxyUrl.split('/')[2], attempts };
      }
      attempts.push({ method: proxyUrl.split('/')[2], ok: false, status: r.status });
    } catch (e) {
      attempts.push({ method: proxyUrl.split('/')[2], ok: false, error: e.message });
    }
  }
 
  const err = new Error('모든 연결 시도 실패 (직접+프록시 전체)');
  err.attempts = attempts;
  throw err;
}
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
 
  const apiKey = process.env.api_key;
  if (!apiKey) {
    return res.status(500).json({ error: 'api_key 환경변수가 없습니다.' });
  }
 
  const BASE = 'https://swopenapi.seoul.go.kr/api/subway';
 
  // ── 진단 모드 ──
  if (req.query.debug === '1') {
    const testUrl = `${BASE}/${apiKey}/json/realtimeStationArrival/0/5/개화`;
    const t0 = Date.now();
    try {
      const { body, via, attempts } = await fetchViaProxyChain(testUrl);
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      return res.status(200).json({
        debug: true,
        elapsed_ms: Date.now() - t0,
        connected_via: via,
        attempts,
        raw_body: parsed || body.slice(0, 500),
      });
    } catch (e) {
      return res.status(200).json({
        debug: true,
        elapsed_ms: Date.now() - t0,
        error: e.message,
        attempts: e.attempts || [],
      });
    }
  }
 
  async function fetchStation(name, idx) {
    const url = `${BASE}/${apiKey}/json/realtimeStationArrival/0/30/${encodeURIComponent(name)}`;
    try {
      const { body } = await fetchViaProxyChain(url);
      let d;
      try { d = JSON.parse(body); } catch {
        return { idx, arrivals: null, errCode: 'PARSE_ERROR', errMsg: body.slice(0, 200) };
      }
      if (d.errorMessage && d.errorMessage.status && d.errorMessage.status >= 400) {
        return { idx, arrivals: null, errCode: d.errorMessage.code, errMsg: d.errorMessage.message };
      }
      return { idx, arrivals: d.realtimeArrivalList || [], errCode: null, errMsg: null };
    } catch (e) {
      return { idx, arrivals: null, errCode: 'ALL_FAILED', errMsg: e.message };
    }
  }
 
  try {
    const results = await Promise.all(STATIONS.map((name, idx) => fetchStation(name, idx)));
 
    const trainMap = new Map();
    const AVG_SEC = 90;
 
    results.forEach(({ idx: stnIdx, arrivals }) => {
      if (!arrivals) return;
      arrivals.forEach(a => {
        const is9 = a.subwayId === '1009' || (a.trainLineNm && a.trainLineNm.includes('9호선')) || (a.subwayList && a.subwayList.includes('1009'));
        if (!is9) return;
 
        const num = a.btrainNo;
        if (!num || trainMap.has(num)) return;
 
        const isUp = a.updnLine === '상행';
        const barvlDt = parseInt(a.barvlDt || '0', 10);
        const stationsAway = Math.min(barvlDt / AVG_SEC, 3);
 
        let pos = isUp ? stnIdx - stationsAway : stnIdx + stationsAway;
        pos = Math.max(0, Math.min(STATIONS.length - 1, pos));
 
        trainMap.set(num, {
          id: num, num,
          dir: isUp ? 'up' : 'down',
          pos,
          express: a.btrainSttus === '급행' || a.btrainSttus === '특급',
          speed: 0,
          statnNm: STATIONS[stnIdx],
          barvlDt,
          arvlMsg2: a.arvlMsg2 || '',
        });
      });
    });
 
    const trains = [...trainMap.values()];
    const successCount = results.filter(r => r.arrivals !== null).length;
    const errorSamples = results.filter(r => r.errCode).slice(0, 5).map(r => ({
      station: STATIONS[r.idx], code: r.errCode, message: r.errMsg
    }));
 
    if (trains.length === 0) {
      return res.status(200).json({
        trains: [],
        warning: `9호선 열차 데이터 없음 (정상응답: ${successCount}/${STATIONS.length})`,
        error_samples: errorSamples,
      });
    }
 
    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=10');
    return res.status(200).json({ trains, count: trains.length, success_stations: successCount });
 
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
