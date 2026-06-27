// api/subway.js
// Vercel Serverless Function — 서울 지하철 실시간 위치 API 프록시
// 환경변수 api_key 를 서버에서만 사용하므로 클라이언트에 키가 노출되지 않습니다.

export default async function handler(req, res) {
  // CORS 허용 (같은 도메인 + 로컬 개발)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const apiKey = (process.env.api_key || process.env.API_KEY || process.env.SEOUL_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다. Vercel 환경변수 api_key 를 확인하세요.' });
  }

  // 쿼리 파라미터
  const { line = '9호선', start = '0', end = '100' } = req.query;
  const startNo = Number.parseInt(start, 10);
  const endNo = Number.parseInt(end, 10);

  if (!Number.isFinite(startNo) || !Number.isFinite(endNo)) {
    return res.status(400).json({ error: 'start/end 값이 올바르지 않습니다.' });
  }

  const url = `https://swopenapi.seoul.go.kr/api/subway/${apiKey}/json/realtimePosition/${startNo}/${endNo}/${encodeURIComponent(line)}`;

  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      // Vercel 함수 타임아웃 대비
      signal: AbortSignal.timeout(8000),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return res.status(502).json({
        error: `서울 API 오류: ${response.status}`,
        detail: data?.errorMessage?.message || data?.message || null,
      });
    }

    if (!data) {
      return res.status(502).json({ error: '서울 API 응답을 읽을 수 없습니다.' });
    }

    // 서울 API 에러 응답 처리
    const apiStatus = String(data.errorMessage?.status || '');
    if (data.errorMessage && apiStatus && apiStatus !== 'INFO-000') {
      return res.status(502).json({ error: data.errorMessage.message || '서울 API 오류' });
    }

    // 캐시 30초 (CDN 엣지 캐시)
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=10');
    return res.status(200).json(data);

  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: '서울 API 응답 시간 초과' });
    }
    return res.status(500).json({ error: err.message });
  }
}
