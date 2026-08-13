/**
 * 株ナビ 個人用データ取得・配信ワーカー（Cloudflare Workers）
 */

const WATCHLIST = [
  "7203", "8306", "9432", "9433", "8058", "2914", "9984", "6758",
  "7267", "4661", "8801", "9020", "5401", "8316", "3382", "4502",
  "6501", "2432",
];

const JQUANTS_BASE = "https://api.jquants.com/v2";
const FETCH_DAYS = 400;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/admin/run-fetch") {
      if (!checkToken(request, env)) return unauthorized();
      const result = await fetchAndStore(env);
      return json({ ok: true, result });
    }

    if (url.pathname === "/api/stocks" && request.method === "GET") {
      if (!checkToken(request, env)) return unauthorized();
      const stocks = [];
      for (const code of WATCHLIST) {
        const raw = await env.PRICES_KV.get(`meta:${code}`);
        stocks.push(raw ? JSON.parse(raw) : { code, latest: null });
      }
      return json({ stocks, watchlist: WATCHLIST });
    }

    const m = url.pathname.match(/^\/api\/stocks\/([0-9A-Za-z]+)\/history$/);
    if (m && request.method === "GET") {
      if (!checkToken(request, env)) return unauthorized();
      const code = m[1];
      const raw = await env.PRICES_KV.get(`history:${code}`);
      const history = raw ? JSON.parse(raw) : [];
      return json({ code, history });
    }

    if (url.pathname === "/") {
      return json({ status: "ok", message: "株ナビ 個人用データワーカーです。" });
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStore(env));
  },
};

function checkToken(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("x-access-token");
  return Boolean(token) && Boolean(env.ACCESS_TOKEN) && token === env.ACCESS_TOKEN;
}

function unauthorized() {
  return json({ error: "unauthorized（tokenが違います）" }, 401);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

async function fetchAndStore(env) {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - FETCH_DAYS * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const results = {};

  for (const code of WATCHLIST) {
    try {
      const rows = await fetchAllPages(code, fmt(fromDate), fmt(toDate), env.JQUANTS_API_KEY);
      const history = rows
        .map((r) => ({
          date: (r.Date || "").slice(0, 10),
          open: r.AdjO,
          high: r.AdjH,
          low: r.AdjL,
          close: r.AdjC,
          volume: r.AdjVo,
        }))
        .filter((h) => h.date && h.close != null)
        .sort((a, b) => a.date.localeCompare(b.date));

      await env.PRICES_KV.put(`history:${code}`, JSON.stringify(history));
      const latest = history[history.length - 1] || null;
      await env.PRICES_KV.put(
        `meta:${code}`,
        JSON.stringify({ code, latest: latest ? { date: latest.date, close: latest.close } : null, updatedAt: new Date().toISOString() })
      );
      results[code] = { rows: history.length };
    } catch (e) {
      results[code] = { error: String(e && e.message ? e.message : e) };
    }
  }
  return results;
}

async function fetchAllPages(code, fromYmd, toYmd, apiKey) {
  let all = [];
  let paginationKey = null;
  let guard = 0;
  while (guard < 20) {
    guard++;
    const params = new URLSearchParams({ code, from: fromYmd, to: toYmd });
    if (paginationKey) params.set("pagination_key", paginationKey);
    const resp = await fetch(`${JQUANTS_BASE}/equities/bars/daily?${params.toString()}`, {
      headers: { "x-api-key": apiKey },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const payload = await resp.json();
    const batch = Array.isArray(payload.data) ? payload.data : [];
    all = all.concat(batch);
    if (!payload.pagination_key) break;
    paginationKey = payload.pagination_key;
  }
  return all;
}
