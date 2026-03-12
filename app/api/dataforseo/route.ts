import { NextRequest, NextResponse } from "next/server";

const BASE = "https://api.dataforseo.com/v3";

function getAuth(): string {
  const l = process.env.DATAFORSEO_LOGIN!;
  const p = process.env.DATAFORSEO_PASSWORD!;
  return Buffer.from(`${l}:${p}`).toString("base64");
}

async function dfs(endpoint: string, body: unknown[]) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Basic ${getAuth()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DFS ${endpoint}: ${res.status}`);
  const data = await res.json();
  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) throw new Error(`DFS error: ${task?.status_message || "Unknown"}`);
  return task.result;
}

export async function POST(req: NextRequest) {
  try {
    const { action, domain, competitorDomain, keywords } = await req.json();

    // ═══ DISCOVER COMPETITORS ═══
    if (action === "discover") {
      const [overview, comps] = await Promise.all([
        dfs("/dataforseo_labs/google/domain_rank_overview/live", [{ target: domain, language_code: "es", location_name: "Spain" }]),
        dfs("/dataforseo_labs/google/competitors_domain/live", [{ target: domain, language_code: "es", location_name: "Spain", exclude_top_domains: true, limit: 10, filters: [["metrics.organic.count", ">", 50]] }]),
      ]);

      // Domain overview - extract organic metrics
      const ovItems = overview?.[0]?.items || [];
      const ovFirst = ovItems[0] || {};
      const domOrg = ovFirst?.metrics?.organic || {};

      const domainData = {
        etv: Math.round(domOrg.etv || 0),
        count: domOrg.count || 0,
        cost: Math.round(domOrg.estimated_paid_traffic_cost || 0),
        top10: (domOrg.pos_1 || 0) + (domOrg.pos_2_3 || 0) + (domOrg.pos_4_10 || 0),
      };

      // Competitors - use full_domain_metrics for their real ETV
      const compItems = comps?.[0]?.items || [];
      const competitors = compItems
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
            active: !big && (c.intersections || 0) > 300,
          };
        });

      return NextResponse.json({ domain: domainData, competitors });
    }

    // ═══ GAP KEYWORDS ═══
    if (action === "gap") {
      const items = await dfs("/dataforseo_labs/google/page_intersection/live", [{
        pages: [`https://www.${competitorDomain}/*`],
        exclude_pages: [`https://www.${domain}/*`],
        language_code: "es", location_name: "Spain", limit: 50,
        order_by: ["keyword_data.keyword_info.search_volume,desc"],
      }]);
      const gaps = (items?.[0]?.items || []).map((it: any) => {
        const kd = it.keyword_data || {};
        const ki = kd.keyword_info || {};
        const ir = it.intersection_result?.["1"] || {};
        return { kw: kd.keyword || "", vol: ki.search_volume || 0, cpc: ki.cpc || 0, intent: kd.search_intent_info?.main_intent || "", kd: kd.keyword_properties?.keyword_difficulty || 0, posComp: ir.rank_absolute || 0 };
      }).filter((g: any) => g.vol > 0);
      return NextResponse.json({ gaps });
    }

    // ═══ SHARED KEYWORDS ═══
    if (action === "shared") {
      const items = await dfs("/dataforseo_labs/google/page_intersection/live", [{
        pages: [`https://www.${domain}/*`, `https://www.${competitorDomain}/*`],
        intersection_mode: "intersect",
        language_code: "es", location_name: "Spain", limit: 50,
        order_by: ["keyword_data.keyword_info.search_volume,desc"],
      }]);
      const shared = (items?.[0]?.items || []).map((it: any) => {
        const kd = it.keyword_data || {};
        const ki = kd.keyword_info || {};
        const r1 = it.intersection_result?.["1"] || {};
        const r2 = it.intersection_result?.["2"] || {};
        return { kw: kd.keyword || "", vol: ki.search_volume || 0, posQ: r1.rank_absolute || 0, posC: r2.rank_absolute || 0 };
      }).filter((s: any) => s.vol > 0);
      return NextResponse.json({ shared });
    }

    // ═══ KEYWORD ENRICHMENT (KD + vol) ═══
    if (action === "keywords" && keywords?.length) {
      const items = await dfs("/dataforseo_labs/google/keyword_overview/live", [{
        keywords: keywords.slice(0, 700),
        language_code: "es", location_name: "Spain",
      }]);
      const enriched = (items?.[0]?.items || []).map((it: any) => ({
        kw: it.keyword || "",
        vol: it.keyword_info?.search_volume || 0,
        kd: it.keyword_properties?.keyword_difficulty || 0,
        cpc: it.keyword_info?.cpc || 0,
        intent: it.search_intent_info?.main_intent || "",
      }));
      return NextResponse.json({ keywords: enriched });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    console.error("DataForSEO error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
