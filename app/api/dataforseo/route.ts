import { NextRequest, NextResponse } from "next/server";

const BASE = "https://api.dataforseo.com/v3";

function getAuth(): string {
  const l = process.env.DATAFORSEO_LOGIN || "";
  const p = process.env.DATAFORSEO_PASSWORD || "";
  return Buffer.from(`${l}:${p}`).toString("base64");
}

async function dfs(endpoint: string, body: unknown[]): Promise<any> {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Basic ${getAuth()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`DFS parse error: ${text.slice(0, 200)}`); }
  const task = data.tasks?.[0];
  if (!task) throw new Error("DFS: no tasks in response");
  if (task.status_code !== 20000) throw new Error(`DFS ${task.status_code}: ${task.status_message}`);
  return task.result || [];
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, domain, competitorDomain, keywords } = body;

    // ═══ DISCOVER COMPETITORS ═══
    if (action === "discover") {
      // 1. Domain overview
      let domainData = { etv: 0, count: 0, cost: 0, top10: 0 };
      try {
        const ovResult = await dfs("/dataforseo_labs/google/domain_rank_overview/live", [
          { target: domain, language_code: "es", location_name: "Spain" }
        ]);
        const org = ovResult?.[0]?.items?.[0]?.metrics?.organic || {};
        domainData = {
          etv: Math.round(org.etv || 0),
          count: org.count || 0,
          cost: Math.round(org.estimated_paid_traffic_cost || 0),
          top10: (org.pos_1 || 0) + (org.pos_2_3 || 0) + (org.pos_4_10 || 0),
        };
      } catch (e: any) { console.error("Domain overview error:", e.message); }

      // 2. Competitors
      let competitors: any[] = [];
      try {
        const compResult = await dfs("/dataforseo_labs/google/competitors_domain/live", [
          { target: domain, language_code: "es", location_name: "Spain", exclude_top_domains: true, limit: 10, filters: [["metrics.organic.count", ">", 50]] }
        ]);
        const items = compResult?.[0]?.items || [];
        competitors = items
          .filter((c: any) => c.domain !== domain)
          .map((c: any) => {
            const fdm = c.full_domain_metrics?.organic || {};
            const big = (fdm.count || 0) > 50000;
            return {
              domain: c.domain,
              etv: Math.round(fdm.etv || 0),
              count: fdm.count || 0,
              cost: Math.round(fdm.estimated_paid_traffic_cost || 0),
              top10: (fdm.pos_1 || 0) + (fdm.pos_2_3 || 0) + (fdm.pos_4_10 || 0),
              avgPos: +(c.avg_position || 0).toFixed(1),
              shared: c.intersections || 0,
              type: big ? "Marketplace" : "E-comm",
              source: "auto",
              active: !big && (c.intersections || 0) > 300,
            };
          });
      } catch (e: any) { console.error("Competitors error:", e.message); }

      return NextResponse.json({ domain: domainData, competitors });
    }

    // ═══ GAP: competitor ranks, you don't ═══
    if (action === "gap" && competitorDomain) {
      try {
        const result = await dfs("/dataforseo_labs/google/page_intersection/live", [{
          pages: [`https://www.${competitorDomain}/*`],
          exclude_pages: [`https://www.${domain}/*`],
          language_code: "es",
          location_name: "Spain",
          limit: 50,
          order_by: ["keyword_data.keyword_info.search_volume,desc"],
        }]);
        const items = result?.[0]?.items || [];
        const gaps = items.map((it: any) => {
          const kd = it.keyword_data || {};
          const ki = kd.keyword_info || {};
          const ir = it.intersection_result?.["1"] || {};
          return { kw: kd.keyword || "", vol: ki.search_volume || 0, kd: kd.keyword_properties?.keyword_difficulty || 0, posComp: ir.rank_absolute || 0 };
        }).filter((g: any) => g.vol > 0);
        return NextResponse.json({ gaps });
      } catch (e: any) {
        console.error(`Gap error for ${competitorDomain}:`, e.message);
        return NextResponse.json({ gaps: [], error: e.message });
      }
    }

    // ═══ SHARED: both rank ═══
    if (action === "shared" && competitorDomain) {
      try {
        const result = await dfs("/dataforseo_labs/google/page_intersection/live", [{
          pages: [`https://www.${domain}/*`, `https://www.${competitorDomain}/*`],
          intersection_mode: "intersect",
          language_code: "es",
          location_name: "Spain",
          limit: 50,
          order_by: ["keyword_data.keyword_info.search_volume,desc"],
        }]);
        const items = result?.[0]?.items || [];
        const shared = items.map((it: any) => {
          const kd = it.keyword_data || {};
          const ki = kd.keyword_info || {};
          const r1 = it.intersection_result?.["1"] || {};
          const r2 = it.intersection_result?.["2"] || {};
          return { kw: kd.keyword || "", vol: ki.search_volume || 0, posQ: r1.rank_absolute || 0, posC: r2.rank_absolute || 0 };
        }).filter((s: any) => s.vol > 0);
        return NextResponse.json({ shared });
      } catch (e: any) {
        console.error(`Shared error for ${competitorDomain}:`, e.message);
        return NextResponse.json({ shared: [], error: e.message });
      }
    }

    // ═══ KEYWORD ENRICHMENT ═══
    if (action === "keywords" && keywords?.length) {
      try {
        const result = await dfs("/dataforseo_labs/google/keyword_overview/live", [{
          keywords: keywords.slice(0, 700),
          language_code: "es",
          location_name: "Spain",
        }]);
        const enriched = (result?.[0]?.items || []).map((it: any) => ({
          kw: it.keyword || "",
          vol: it.keyword_info?.search_volume || 0,
          kd: it.keyword_properties?.keyword_difficulty || 0,
          cpc: it.keyword_info?.cpc || 0,
          intent: it.search_intent_info?.main_intent || "",
        }));
        return NextResponse.json({ keywords: enriched });
      } catch (e: any) {
        console.error("Keywords error:", e.message);
        return NextResponse.json({ keywords: [], error: e.message });
      }
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    console.error("DataForSEO route error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
