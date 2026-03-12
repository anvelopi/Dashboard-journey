"use client";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";

type GscSite = { siteUrl: string; permissionLevel: string };
type Ga4Prop = { property: string; displayName: string; parent: string };

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [gscSites, setGscSites] = useState<GscSite[]>([]);
  const [ga4Props, setGa4Props] = useState<Ga4Prop[]>([]);
  const [selectedGsc, setSelectedGsc] = useState("");
  const [selectedGa4, setSelectedGa4] = useState("");
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [dashData, setDashData] = useState<any>(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [journey, setJourney] = useState<any>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => { if (status === "unauthenticated") router.push("/"); }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    Promise.all([
      fetch("/api/gsc?action=sites").then(r => r.json()),
      fetch("/api/ga4?action=accounts").then(r => r.json()),
      fetch("/api/insights").then(r => r.json()),
    ]).then(([gsc, ga4, ai]) => {
      const sites = (gsc.siteEntry || []).map((s: any) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
      setGscSites(sites);
      if (sites.length) setSelectedGsc(sites[0].siteUrl);
      const props: Ga4Prop[] = [];
      (ga4.accountSummaries || []).forEach((acc: any) => {
        (acc.propertySummaries || []).forEach((p: any) => {
          props.push({ property: p.property?.replace("properties/", "") || "", displayName: p.displayName || p.property, parent: acc.displayName || acc.name });
        });
      });
      setGa4Props(props);
      if (props.length) setSelectedGa4(props[0].property);
      setAiEnabled(ai.enabled);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [status]);

  const fetchData = useCallback(async () => {
    if (!selectedGsc || !selectedGa4) return;
    setDataLoading(true);
    setJourney(null);
    try {
      const [kwRes, pageGa4Res] = await Promise.all([
        fetch("/api/gsc?action=keywords&site=" + encodeURIComponent(selectedGsc)).then(r => r.json()),
        fetch("/api/ga4?action=pages&property=" + selectedGa4).then(r => r.json()),
      ]);
      const keywords = (kwRes.rows || []).map((r: any) => ({
        kw: r.keys[0], clicks: r.clicks, imp: r.impressions, ctr: +(r.ctr * 100).toFixed(2), pos: +r.position.toFixed(1),
      }));
      const ga4Pages = (pageGa4Res.rows || []).map((r: any) => ({
        page: r.dimensionValues[0].value, sessions: +r.metricValues[0].value, engaged: +r.metricValues[1].value,
        duration: +parseFloat(r.metricValues[2].value).toFixed(0), purchases: +r.metricValues[3].value, revenue: +parseFloat(r.metricValues[4].value).toFixed(2),
      }));
      const totalRevenue = ga4Pages.reduce((s: number, p: any) => s + p.revenue, 0);
      const totalPurchases = ga4Pages.reduce((s: number, p: any) => s + p.purchases, 0);
      const totalSessions = ga4Pages.reduce((s: number, p: any) => s + p.sessions, 0);
      const data = {
        domain: selectedGsc.replace("sc-domain:", "").replace(/https?:\/\//, "").replace(/\/$/, ""),
        keywords, ga4Pages,
        revenue: { total: totalRevenue.toFixed(0), transactions: totalPurchases, sessions: totalSessions },
      };
      setDashData(data);
      setDataLoading(false);
      if (aiEnabled) fetchInsights(data);
    } catch (err) { console.error(err); setDataLoading(false); }
  }, [selectedGsc, selectedGa4, aiEnabled]);

  const fetchInsights = async (data: any) => {
    setAiLoading(true);
    try {
      const res = await fetch("/api/insights", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: data.domain, keywords: data.keywords, pages: data.ga4Pages, revenue: data.revenue }),
      });
      const json = await res.json();
      if (json.journey) setJourney(json.journey);
    } catch (err) { console.error(err); }
    setAiLoading(false);
  };

  useEffect(() => {
    if (!dashData || !iframeRef.current) return;
    const html = generateDashboardHTML(dashData, journey, aiEnabled, aiLoading);
    iframeRef.current.srcdoc = html;
  }, [dashData, journey, aiEnabled, aiLoading]);

  if (status === "loading" || loading) return <div className="loading-wrap"><div className="spinner"></div>Cargando propiedades de Google...</div>;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="prop-selector">
        <div><label>Search Console: </label>
          <select value={selectedGsc} onChange={e => setSelectedGsc(e.target.value)}>
            {gscSites.map(s => <option key={s.siteUrl} value={s.siteUrl}>{s.siteUrl} ({s.permissionLevel})</option>)}
          </select></div>
        <div><label>Analytics: </label>
          <select value={selectedGa4} onChange={e => setSelectedGa4(e.target.value)}>
            {ga4Props.map(p => <option key={p.property} value={p.property}>{p.displayName} ({p.property})</option>)}
          </select></div>
        <button onClick={fetchData} disabled={dataLoading} style={{
          padding: "0.4rem 1.2rem", borderRadius: 8, border: "none", background: "#0d6e5b", color: "#fff",
          fontFamily: "'DM Sans',sans-serif", fontSize: "0.8rem", fontWeight: 600, cursor: dataLoading ? "wait" : "pointer", opacity: dataLoading ? 0.6 : 1,
        }}>{dataLoading ? "Cargando..." : "▶ Generar Dashboard"}</button>
        <span className={"ai-badge " + (aiEnabled ? "on" : "off")}>{aiEnabled ? "🤖 IA ON" : "🤖 IA OFF"}</span>
        <button className="logout-btn" onClick={() => signOut({ callbackUrl: "/" })}>Cerrar sesión</button>
      </div>
      {!dashData ? (
        <div className="loading-wrap" style={{ flex: 1 }}>
          <div style={{ textAlign: "center", color: "var(--text2)" }}>
            <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>📊</div>
            <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem" }}>Selecciona tus propiedades y pulsa &quot;Generar Dashboard&quot;</div>
            <div style={{ fontSize: "0.8rem" }}>Los datos se obtienen en directo de Search Console y Analytics</div>
          </div>
        </div>
      ) : (
        <iframe ref={iframeRef} style={{ flex: 1, border: "none", width: "100%", minHeight: "calc(100vh - 60px)" }} title="Dashboard" />
      )}
    </div>
  );
}

function generateDashboardHTML(data: any, journey: any, aiEnabled: boolean, aiLoading: boolean): string {
  const PH = ["Descubrimiento","Investigación","Evaluación","Decisión","Compra","Post-venta"];
  const PCS = ["#0d6e5b","#0a5a49","#087a5e","#00b4d8","#d97706","#b91c1c"];
  const defaultColors: Record<string,string> = {A1:"#00b4d8",A2:"#0d6e5b",A3:"#d97706",A4:"#7c3aed"};

  const kws = journey?.keywords_classified || data.keywords.slice(0,60).map((k:any,i:number)=>({
    ...k, phase: PH[Math.min(Math.floor(i/10),5)], intent: "Informacional", archs: ["A1"]
  }));
  const archs = journey?.archetypes || [
    {id:"A1",name:"Perfil 1",icon:"👤",desc:"Cargando análisis IA...",pct:25,color:"#00b4d8"},
    {id:"A2",name:"Perfil 2",icon:"👤",desc:"Cargando análisis IA...",pct:25,color:"#0d6e5b"},
    {id:"A3",name:"Perfil 3",icon:"👤",desc:"Cargando análisis IA...",pct:25,color:"#d97706"},
    {id:"A4",name:"Perfil 4",icon:"👤",desc:"Cargando análisis IA...",pct:25,color:"#7c3aed"},
  ];
  const pains = journey?.pain_points || [];
  const gaps = journey?.content_gaps || [];
  const recs = journey?.recommendations || [];
  const ins = journey?.insights || {};

  const kwsJSON = JSON.stringify(kws);
  const archsJSON = JSON.stringify(archs);
  const painsJSON = JSON.stringify(pains);
  const gapsJSON = JSON.stringify(gaps);
  const recsJSON = JSON.stringify(recs);
  const insJSON = JSON.stringify(ins);
  const pagesJSON = JSON.stringify(data.ga4Pages?.slice(0,30) || []);

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#f0f4f3;--surface:#fff;--surface2:#f5f8f7;--surface3:#eaf0ee;--border:#cdd9d4;--text:#0f2b2a;--text2:#4a5e5c;--text3:#7a9190;--accent:#0d6e5b;--accent2:#0a5a49;--gold:#00b4d8;--gold2:#0096b4;--a1:#00b4d8;--a2:#0d6e5b;--a3:#d97706;--a4:#7c3aed;--danger:#b91c1c;--warn:#d97706;--success:#0d6e5b;--radius:12px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
.mono{font-family:'Space Mono',monospace}
header{background:linear-gradient(135deg,#0d6e5b,#0a5a49,#0d6e5b);border-bottom:2px solid var(--gold);padding:2rem;position:relative;overflow:hidden}
header::before{content:'';position:absolute;top:-50%;right:-10%;width:500px;height:500px;background:radial-gradient(circle,rgba(0,180,216,.12),transparent 70%);pointer-events:none}
header h1{font-size:1.5rem;font-weight:700;color:#fff}
header p{color:rgba(255,255,255,.7);font-size:.85rem;margin-top:.25rem}
.kpi-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;padding:1rem 2rem;background:var(--surface);border-bottom:1px solid var(--border)}
.kpi{text-align:center;padding:.4rem}
.kpi-val{font-family:'Space Mono',monospace;font-size:1.35rem;font-weight:700;color:var(--accent)}
.kpi-val.gold{color:var(--gold)}
.kpi-label{font-size:.62rem;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;margin-top:.1rem}
.filters{display:flex;gap:.5rem;padding:.75rem 2rem;flex-wrap:wrap;align-items:center;background:var(--surface);border-bottom:1px solid var(--border)}
.filters label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text2);margin-right:.2rem}
.filter-group{display:flex;gap:.3rem;align-items:center;margin-right:1rem}
.fbtn{padding:.25rem .55rem;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text2);font-family:'DM Sans',sans-serif;font-size:.72rem;cursor:pointer;transition:all .15s}
.fbtn:hover{border-color:var(--accent);color:var(--text)}
.fbtn.active{background:var(--accent);border-color:var(--accent);color:#fff}
.search-box{padding:.35rem .6rem;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-family:'DM Sans',sans-serif;font-size:.8rem;width:180px;outline:none}
.search-box:focus{border-color:var(--accent)}
.dashboard{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;padding:1.5rem 2rem;max-width:1600px;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;box-shadow:0 1px 3px rgba(13,110,91,.06)}
.card.full{grid-column:1/-1}
.card-title{font-size:.76rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text2);margin-bottom:.75rem;display:flex;align-items:center;gap:.4rem}
.card-title .dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
.card-title .dot.warn{background:var(--warn)}.card-title .dot.danger{background:var(--danger)}.card-title .dot.success{background:var(--success)}
.chart-wrap{position:relative;height:300px}
.arch-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem}
.arch-card{border-radius:10px;padding:.9rem;border:1px solid var(--border);background:var(--surface2);position:relative;overflow:hidden}
.arch-card::after{content:'';position:absolute;top:0;left:0;width:100%;height:3px}
.arch-card h3{font-size:.8rem;font-weight:700;margin-bottom:.35rem}
.arch-card .desc{font-size:.66rem;color:var(--text2);line-height:1.4;margin-bottom:.4rem}
.arch-card .weight-row{display:flex;gap:.75rem;margin-top:.3rem}
.arch-card .weight-val{font-family:'Space Mono',monospace;font-size:1.05rem;font-weight:700}
.arch-card .weight-lbl{font-size:.55rem;color:var(--text3);text-transform:uppercase;letter-spacing:.04em}
.heatmap{width:100%;border-collapse:separate;border-spacing:3px}
.heatmap th{font-size:.64rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);padding:.4rem;text-align:center}
.heatmap th.row-h{text-align:left;font-size:.68rem;color:var(--text);max-width:130px}
.heatmap td{text-align:center;padding:.4rem .25rem;border-radius:6px;font-family:'Space Mono',monospace;font-size:.74rem;font-weight:700;cursor:default;transition:transform .15s}
.heatmap td:hover{transform:scale(1.06);z-index:2}
.heatmap td .sub{display:block;font-family:'DM Sans',sans-serif;font-size:.54rem;font-weight:400;opacity:.8;margin-top:1px}
.journey-map{display:grid;grid-template-columns:120px repeat(6,1fr);gap:2px;font-size:.66rem}
.jm-phase{text-align:center;padding:.4rem .15rem;font-weight:700;font-size:.6rem;text-transform:uppercase;letter-spacing:.04em;border-radius:6px 6px 0 0;color:#fff}
.jm-arch-label{display:flex;align-items:center;padding:.25rem;font-weight:600;font-size:.66rem;border-radius:6px 0 0 6px}
.jm-cell{background:var(--surface2);padding:.4rem;border-radius:4px;border:1px solid transparent;min-height:70px;transition:border-color .2s}
.jm-cell:hover{border-color:rgba(13,110,91,.3)}
.jm-cell .kw-list{list-style:none;font-size:.62rem;color:var(--text2);line-height:1.3}
.jm-cell .kw-list li{margin-bottom:.06rem}
.jm-cell .kw-list .vol{font-family:'Space Mono',monospace;font-size:.54rem;color:var(--accent)}
.jm-cell .insight-body{max-height:0;overflow:hidden;transition:max-height .3s ease,opacity .2s;opacity:0}
.jm-cell .insight-body.open{max-height:800px;opacity:1}
.ins-toggle{font-size:.54rem;color:var(--gold2);cursor:pointer;display:inline-flex;align-items:center;gap:.2rem;padding:.08rem .25rem;border-radius:3px;background:rgba(0,180,216,.06);border:1px solid rgba(0,180,216,.2);transition:all .2s;user-select:none;margin-top:.25rem}
.ins-toggle:hover{background:rgba(0,180,216,.12)}
.insight-body{font-size:.58rem;color:var(--text2);line-height:1.3;margin-top:.15rem;padding-top:.15rem;border-top:1px dashed rgba(0,180,216,.25)}
.insight-body .ib-s{margin-bottom:.25rem}
.insight-body .ib-l{font-weight:700;color:var(--text);font-size:.56rem;text-transform:uppercase;letter-spacing:.03em;margin-bottom:.04rem}
.insight-body .pain{color:var(--danger);font-size:.56rem}
.insight-body .gain{color:var(--success);font-size:.56rem}
.pain-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:.5rem}
.pain-card{background:var(--surface2);border-left:3px solid var(--danger);border-radius:0 8px 8px 0;padding:.6rem .85rem}
.pain-card .pt{font-size:.74rem;font-weight:600;color:var(--danger);margin-bottom:.12rem;display:flex;align-items:center;gap:.4rem}
.sev-dots{display:inline-flex;gap:3px}
.sev-dot{width:7px;height:7px;border-radius:50%;background:rgba(185,28,28,.1);border:1px solid rgba(185,28,28,.2)}
.sev-dot.on{background:var(--danger);border-color:var(--danger);box-shadow:0 0 3px rgba(185,28,28,.3)}
.pain-card .pd{font-size:.66rem;color:var(--text2);line-height:1.3;margin-bottom:.2rem}
.pain-card .pm{display:flex;gap:.3rem;font-size:.56rem;color:var(--text3);flex-wrap:wrap}
.pain-card .pm span{padding:.06rem .2rem;border-radius:3px;background:rgba(13,110,91,.08)}
.gap-list{display:flex;flex-direction:column;gap:.4rem}
.gap-item{display:grid;grid-template-columns:1fr 80px;gap:.4rem;align-items:start;padding:.6rem .8rem;background:var(--surface2);border:1px solid var(--border);border-radius:8px;border-left:3px solid var(--accent)}
.gap-item .gt{font-size:.76rem;font-weight:600;color:var(--text)}
.gap-item .gk{font-size:.62rem;color:var(--text3);margin-top:.12rem}
.gap-item .gpri{text-align:right}
.gap-item .gpb{display:inline-block;padding:.12rem .4rem;border-radius:4px;font-size:.6rem;font-weight:700;text-transform:uppercase}
.gap-item .gpb.alta{background:rgba(185,28,28,.1);color:var(--danger)}
.gap-item .gpb.media{background:rgba(217,119,6,.1);color:var(--warn)}
.gap-item .gpb.baja{background:rgba(13,110,91,.1);color:var(--success)}
.rec-card{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:.7rem .9rem;margin-bottom:.5rem}
.rec-card .rc-head{display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem;flex-wrap:wrap}
.rec-card .rc-title{font-size:.78rem;font-weight:700;color:var(--text)}
.rec-card .rc-tag{font-size:.56rem;padding:.1rem .35rem;border-radius:3px;font-weight:700;text-transform:uppercase}
.rec-card .rc-desc{font-size:.68rem;color:var(--text2);line-height:1.4}
.rec-card .rc-meta{display:flex;gap:.5rem;margin-top:.3rem;font-size:.58rem;color:var(--text3);flex-wrap:wrap}
.rec-card .rc-meta span{padding:.06rem .3rem;border-radius:3px;background:rgba(13,110,91,.06)}
.kw-table-wrap{max-height:480px;overflow-y:auto;overflow-x:auto;scrollbar-width:thin}
.kw-table{width:100%;border-collapse:collapse;font-size:.74rem;min-width:650px}
.kw-table thead{position:sticky;top:0;z-index:5}
.kw-table th{background:var(--surface2);padding:.45rem .35rem;text-align:left;font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap}
.kw-table th:hover{color:var(--accent)}
.kw-table td{padding:.35rem;border-bottom:1px solid rgba(13,110,91,.08);vertical-align:middle}
.kw-table tr:hover td{background:rgba(13,110,91,.04)}
.pill{display:inline-block;padding:.08rem .35rem;border-radius:4px;font-size:.6rem;font-weight:600;white-space:nowrap}
.method-toggle{cursor:pointer;display:flex;align-items:center;gap:.35rem;padding:.35rem .55rem;border-radius:6px;border:1px solid var(--border);background:var(--surface2);font-size:.72rem;font-weight:600;color:var(--text2);transition:all .2s;user-select:none;margin-bottom:.4rem}
.method-toggle:hover{border-color:rgba(13,110,91,.25);color:var(--text)}
.method-toggle .mt-chv{transition:transform .2s;font-size:.5rem}
.method-toggle.open .mt-chv{transform:rotate(90deg)}
.method-body{max-height:0;overflow:hidden;transition:max-height .4s ease,opacity .3s;opacity:0;font-size:.72rem;color:var(--text2);line-height:1.5}
.method-body.open{max-height:50000px;opacity:1}
.method-body p{margin-bottom:.4rem}
.ai-loading{text-align:center;padding:2rem;color:var(--text3)}
.ai-loading .spinner{display:inline-block;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:1100px){.dashboard{grid-template-columns:1fr}.arch-cards{grid-template-columns:repeat(2,1fr)}}
@media(max-width:768px){.dashboard{padding:1rem;gap:.75rem}header{padding:1.5rem 1rem}.arch-cards{grid-template-columns:1fr 1fr}.journey-map{min-width:900px}.card.full{overflow-x:auto}.pain-grid{grid-template-columns:1fr}}
</style></head><body>
<header>
  <h1>Customer Journey SEO — ${data.domain}</h1>
  <p>4 arquetipos × 6 fases × keywords GSC + GA4 ecommerce${aiEnabled ? " + Claude IA insights" : ""}</p>
</header>
<div class="kpi-strip" id="kpiStrip"></div>
<div class="filters">
  <div class="filter-group"><label>Arquetipo:</label><span id="archFilters"></span></div>
  <div class="filter-group"><label>Fase:</label><span id="phaseFilters"></span></div>
  <div class="filter-group" style="margin-left:auto"><input type="text" class="search-box" id="kwSearch" placeholder="Buscar keyword..."></div>
</div>
<div class="dashboard">
  <div class="card full"><div class="card-title"><span class="dot"></span>Arquetipos de usuario${aiLoading?" · <span style='color:var(--gold)'>Analizando con IA...</span>":""}</div><div class="arch-cards" id="archCards"></div></div>
  <div class="card"><div class="card-title"><span class="dot"></span>Impresiones vs Posición GSC</div><div class="chart-wrap"><canvas id="bubbleChart"></canvas></div></div>
  <div class="card"><div class="card-title"><span class="dot"></span>Clicks por fase × arquetipo</div><div class="chart-wrap"><canvas id="phaseBar"></canvas></div></div>
  <div class="card full"><div class="card-title"><span class="dot"></span>Heatmap: Clicks por Arquetipo × Fase</div><div style="overflow-x:auto"><table class="heatmap" id="heatmap" style="min-width:600px"></table></div></div>
  <div class="card"><div class="card-title"><span class="dot"></span>Distribución por intención</div><div class="chart-wrap"><canvas id="intentPie"></canvas></div></div>
  <div class="card"><div class="card-title"><span class="dot"></span>Radar: clicks medios × fase</div><div class="chart-wrap"><canvas id="radarChart"></canvas></div></div>
  ${pains.length ? '<div class="card full"><div class="card-title"><span class="dot danger"></span>Pain Points del Journey</div><div class="pain-grid" id="painGrid"></div></div>' : (aiLoading ? '<div class="card full"><div class="card-title"><span class="dot danger"></span>Pain Points</div><div class="ai-loading"><span class="spinner"></span>Claude está analizando los pain points...</div></div>' : '')}
  <div class="card full"><div class="card-title"><span class="dot warn"></span>Mapa del Journey: Keywords + Insights</div><div style="overflow-x:auto"><div class="journey-map" id="journeyMap"></div></div></div>
  ${gaps.length ? '<div class="card full"><div class="card-title"><span class="dot success"></span>Content Gaps · <span id="gapCount" style="color:var(--success)">'+gaps.length+' gaps</span></div><div class="gap-list" id="gapList"></div></div>' : (aiLoading ? '<div class="card full"><div class="card-title"><span class="dot success"></span>Content Gaps</div><div class="ai-loading"><span class="spinner"></span>Identificando content gaps...</div></div>' : '')}
  ${recs.length ? '<div class="card full"><div class="card-title"><span class="dot" style="background:var(--gold)"></span>🤖 Recomendaciones IA · '+recs.length+' insights</div><div id="recsContent"></div></div>' : (aiLoading ? '<div class="card full"><div class="card-title"><span class="dot" style="background:var(--gold)"></span>🤖 Recomendaciones IA</div><div class="ai-loading"><span class="spinner"></span>Generando recomendaciones priorizadas...</div></div>' : (!aiEnabled ? '<div class="card full"><div class="card-title"><span class="dot" style="background:var(--text3)"></span>🤖 Recomendaciones IA</div><div class="ai-loading">Añade ANTHROPIC_API_KEY en Vercel para activar recomendaciones de Claude.</div></div>' : ''))}
  <div class="card full"><div class="card-title"><span class="dot"></span>Tabla completa · <span id="tableCount" style="color:var(--accent)"></span></div><div class="kw-table-wrap"><table class="kw-table" id="kwTable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
  <div class="card full"><div class="card-title"><span class="dot" style="background:var(--text3)"></span>Metodología</div><div class="method-section">
    <div class="method-toggle" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')"><span class="mt-chv">▸</span> Fuentes de datos y cálculos</div>
    <div class="method-body">
      <p><strong>Google Search Console:</strong> Top keywords por impresiones (últimos 28 días).</p>
      <p><strong>Google Analytics 4:</strong> Top páginas por sesiones con métricas de engagement y ecommerce (últimos 30 días).</p>
      <p><strong>Arquetipos:</strong> ${aiEnabled?"Generados por Claude IA analizando patrones de keywords y comportamiento de usuario.":"Placeholder — activa la API de Anthropic para arquetipos reales."}</p>
      <p><strong>Fases:</strong> ${aiEnabled?"Clasificación automática por intención de búsqueda: informacional (Descubrimiento), investigacional (Investigación), comparativa (Evaluación), transaccional (Decisión), brand/checkout (Compra), soporte/recambios (Post-venta).":"Placeholder — activa la API de Anthropic para clasificación real."}</p>
    </div>
  </div></div>
</div>
<script>
var PH=["Descubrimiento","Investigación","Evaluación","Decisión","Compra","Post-venta"];
var PCS=${JSON.stringify(PCS)};
var KW=${kwsJSON};
var ARCHS=${archsJSON};
var PAINS=${painsJSON};
var GAPS=${gapsJSON};
var RECS=${recsJSON};
var INS=${insJSON};
var AR=ARCHS.map(function(a){return a.id});
var AC={};ARCHS.forEach(function(a){AC[a.id]=a.color});
var IC={Informacional:"#3b6fa0",Comercial:"#d97706",Transaccional:"#0d6e5b",Navegacional:"#5a6d94"};
var aA=new Set(AR),aP="all",sT="",sC="clicks",sD=-1;

function fil(){return KW.filter(function(k){if(!k.archs||!k.archs.some(function(a){return aA.has(a)}))return aA.size===AR.length;if(aP!=="all"&&k.phase!==aP)return false;if(sT&&k.kw.toLowerCase().indexOf(sT.toLowerCase())===-1)return false;return true})}

var bC,pB,iP,rC;
function initCharts(){
  Chart.defaults.color='#4a5e5c';Chart.defaults.font.family="'DM Sans',sans-serif";Chart.defaults.font.size=11;
  bC=new Chart(document.getElementById('bubbleChart'),{type:'bubble',data:{datasets:[]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{title:{display:true,text:'Posición →'},grid:{color:'rgba(13,110,91,.08)'},min:0,max:50},y:{title:{display:true,text:'← Impresiones'},grid:{color:'rgba(13,110,91,.08)'},min:0}},plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){var d=c.raw;return[d.label,'Imp: '+d.y+' | Pos: '+d.x]}}}}}});
  pB=new Chart(document.getElementById('phaseBar'),{type:'bar',data:{labels:PH,datasets:[]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',scales:{x:{grid:{color:'rgba(13,110,91,.08)'},title:{display:true,text:'Clicks'}},y:{grid:{display:false}}},plugins:{legend:{position:'bottom',labels:{boxWidth:12,padding:8}}}}});
  iP=new Chart(document.getElementById('intentPie'),{type:'doughnut',data:{labels:[],datasets:[{data:[],backgroundColor:[]}]},options:{responsive:true,maintainAspectRatio:false,cutout:'55%',plugins:{legend:{position:'right',labels:{boxWidth:12,padding:8,font:{size:10}}}}}});
  rC=new Chart(document.getElementById('radarChart'),{type:'radar',data:{labels:PH,datasets:[]},options:{responsive:true,maintainAspectRatio:false,scales:{r:{beginAtZero:true,grid:{color:'rgba(13,110,91,.1)'},angleLines:{color:'rgba(13,110,91,.1)'},ticks:{display:false},pointLabels:{font:{size:9}}}},plugins:{legend:{position:'bottom',labels:{boxWidth:12,padding:8,font:{size:10}}}}}});
}

function updateAll(){
  var d=fil();var tC=d.reduce(function(s,k){return s+k.clicks},0);var tI=d.reduce(function(s,k){return s+k.imp},0);
  document.getElementById('kpiStrip').innerHTML=[{v:d.length,l:'Keywords'},{v:tC.toLocaleString(),l:'Clicks'},{v:tI.toLocaleString(),l:'Impresiones'},{v:'\\u20ac${data.revenue.total}',l:'Revenue 30d',c:'gold'},{v:'${data.revenue.transactions}',l:'Transacciones'},{v:'${data.revenue.sessions}',l:'Sesiones GA4'}].map(function(k){return '<div class="kpi"><div class="kpi-val '+(k.c||'')+'">'+k.v+'</div><div class="kpi-label">'+k.l+'</div></div>'}).join('');
  updAC();updBub(d);updPB(d);updIP(d);updRad(d);updHM(d);updPn();updJM(d);updGap();updRec();updTbl(d);
}

function updAC(){document.getElementById('archCards').innerHTML=ARCHS.filter(function(a){return aA.has(a.id)}).map(function(a){return '<div class="arch-card" style="border-top:3px solid '+a.color+'"><h3 style="color:'+a.color+'">'+a.icon+' '+a.name+'</h3><div class="desc">'+a.desc+'</div><div class="weight-row"><div class="weight-item"><div class="weight-val" style="color:'+a.color+'">'+a.pct+'%</div><div class="weight-lbl">% Tráfico</div></div></div></div>'}).join('')}

function updBub(d){var top=d.slice(0,30);var mx=Math.max.apply(null,top.map(function(k){return k.imp}))||1;bC.data.datasets=[{data:top.map(function(k){return{x:k.pos,y:k.imp,r:Math.max(3,Math.sqrt(k.clicks/5)*3),label:k.kw}}),backgroundColor:'rgba(13,110,91,0.5)',borderColor:'#0d6e5b',borderWidth:1}];bC.options.scales.y.max=mx*1.1;bC.update()}

function updPB(d){pB.data.datasets=ARCHS.filter(function(a){return aA.has(a.id)}).map(function(a){return{label:a.name,data:PH.map(function(p){return d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).reduce(function(s,k){return s+k.clicks},0)}),backgroundColor:a.color+'cc',borderColor:a.color,borderWidth:1,borderRadius:3}});pB.update()}

function updIP(d){var g={};d.forEach(function(k){g[k.intent]=(g[k.intent]||0)+k.clicks});var l=Object.keys(g);iP.data.labels=l;iP.data.datasets[0].data=l.map(function(x){return g[x]});iP.data.datasets[0].backgroundColor=l.map(function(x){return IC[x]||'#666'});iP.update()}

function updRad(d){rC.data.datasets=ARCHS.filter(function(a){return aA.has(a.id)}).map(function(a){return{label:a.name,data:PH.map(function(p){var ks=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1});return ks.length?Math.round(ks.reduce(function(s,k){return s+k.clicks},0)/ks.length):0}),borderColor:a.color,backgroundColor:a.color+'22',pointBackgroundColor:a.color,borderWidth:2,pointRadius:3}});rC.update()}

function updHM(d){var h=document.getElementById('heatmap');var html='<tr><th class="row-h"></th>';PH.forEach(function(p,i){html+='<th style="color:'+PCS[i]+'">'+p+'</th>'});html+='</tr>';
var mx=1;ARCHS.forEach(function(a){PH.forEach(function(p){var v=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).reduce(function(s,k){return s+k.clicks},0);if(v>mx)mx=v})});
ARCHS.filter(function(a){return aA.has(a.id)}).forEach(function(a){html+='<tr><th class="row-h" style="color:'+a.color+'">'+a.name+'</th>';PH.forEach(function(p){var v=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).reduce(function(s,k){return s+k.clicks},0);var n=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).length;var op=Math.min(.9,v/mx+.1);html+='<td style="background:rgba(13,110,91,'+op+');color:'+(op>.5?'#fff':'var(--text)')+'">'+v+'<span class="sub">'+n+' kw</span></td>'});html+='</tr>'});h.innerHTML=html}

function updPn(){var el=document.getElementById('painGrid');if(!el)return;el.innerHTML=PAINS.filter(function(p){return p.archs.some(function(a){return aA.has(a)})}).map(function(p){return '<div class="pain-card"><div class="pt">'+p.title+' <span class="sev-dots">'+[1,2,3,4,5].map(function(i){return '<span class="sev-dot'+(i<=p.sev?' on':'')+'"></span>'}).join('')+'</span></div><div class="pd">'+p.desc+'</div><div class="pm">'+p.phases.map(function(ph){return '<span>'+ph+'</span>'}).join('')+p.archs.map(function(a){return '<span style="background:'+(AC[a]||'var(--accent)')+'22;color:'+(AC[a]||'var(--accent)')+'">'+a+'</span>'}).join('')+'</div></div>'}).join('')}

function updJM(d){var el=document.getElementById('journeyMap');var html='<div></div>';PH.forEach(function(p,i){html+='<div class="jm-phase" style="background:'+PCS[i]+'">'+p+'</div>'});
ARCHS.filter(function(a){return aA.has(a.id)}).forEach(function(a){html+='<div class="jm-arch-label" style="color:'+a.color+';background:'+a.color+'11">'+a.icon+' '+a.name+'</div>';
PH.forEach(function(p){var ks=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1});var ins_data=INS[a.id]&&INS[a.id][p]?INS[a.id][p]:null;var uid=a.id+'_'+p.replace(/[^a-zA-Z]/g,'');
html+='<div class="jm-cell"><ul class="kw-list">';
ks.slice(0,4).forEach(function(k){html+='<li>'+k.kw+' <span class="vol">'+k.clicks+'c #'+k.pos+'</span></li>'});
html+='</ul>';
if(ins_data){html+='<div class="ins-toggle" onclick="tog(&quot;ins_'+uid+'&quot;,this)">☰ Insight</div><div id="ins_'+uid+'" class="insight-body">';
html+='<div class="ib-s"><div class="ib-l">💭 Piensa</div>'+(ins_data.t||'')+'</div>';
html+='<div class="ib-s"><div class="ib-l">❤️ Siente</div>'+(ins_data.f||'')+'</div>';
if(ins_data.p&&ins_data.p.length)html+='<div class="ib-s"><div class="ib-l">🔴 Pains</div>'+ins_data.p.map(function(x){return '<div class="pain">• '+x+'</div>'}).join('')+'</div>';
if(ins_data.g&&ins_data.g.length)html+='<div class="ib-s"><div class="ib-l">🟢 Gains</div>'+ins_data.g.map(function(x){return '<div class="gain">• '+x+'</div>'}).join('')+'</div>';
html+='</div>'}
html+='</div>'})});el.innerHTML=html}

function updGap(){var el=document.getElementById('gapList');if(!el)return;el.innerHTML=GAPS.map(function(g){return '<div class="gap-item" style="border-left-color:'+(AC[g.arch]||'var(--accent)')+'"><div><div class="gt">'+g.title+'</div><div class="gk">'+g.kws+'</div></div><div class="gpri"><span class="gpb '+g.prio+'">'+g.prio+'</span></div></div>'}).join('')}

function updRec(){var el=document.getElementById('recsContent');if(!el)return;var pc={ALTA:'var(--danger)',MEDIA:'var(--warn)',BAJA:'var(--success)'};var tc={SEO:'rgba(13,110,91,.12)',CONTENIDO:'rgba(217,119,6,.12)',TECNICO:'rgba(185,28,28,.12)',CRO:'rgba(0,180,216,.12)',ENLAZADO:'rgba(124,58,237,.12)'};
el.innerHTML=RECS.map(function(r){return '<div class="rec-card" style="border-left:3px solid '+(pc[r.priority]||'var(--accent)')+'"><div class="rc-head"><span class="rc-title">'+r.title+'</span><span class="rc-tag" style="background:rgba(185,28,28,.1);color:var(--danger)">'+r.priority+'</span><span class="rc-tag" style="background:'+(tc[r.type]||'rgba(13,110,91,.08)')+';color:var(--text2)">'+r.type+'</span></div><div class="rc-desc">'+r.description+'</div><div class="rc-meta"><span>📍 '+r.phase+'</span><span>💰 '+r.impact+'</span><span>⏱ '+r.effort+'</span></div></div>'}).join('')}

function updTbl(d){var hdr=document.querySelector('#kwTable thead tr');var cols=[{k:'kw',l:'Keyword'},{k:'phase',l:'Fase'},{k:'intent',l:'Intent'},{k:'clicks',l:'Clicks'},{k:'imp',l:'Imp'},{k:'ctr',l:'CTR%'},{k:'pos',l:'Pos'}];
hdr.innerHTML=cols.map(function(c){return '<th data-col="'+c.k+'"'+(c.k!=='kw'?' class="right"':'')+'>'+c.l+(sC===c.k?(sD>0?' ▲':' ▼'):'')+'</th>'}).join('');
var sorted=d.slice().sort(function(a,b){var va=a[sC],vb=b[sC];if(typeof va==='string')return va.localeCompare(vb)*sD;return(va-vb)*sD});
document.getElementById('tableCount').textContent=sorted.length+' keywords';
var tbody=document.querySelector('#kwTable tbody');tbody.innerHTML=sorted.map(function(k){var pc=k.pos<=5?'color:var(--success)':k.pos<=10?'color:var(--warn)':'color:var(--danger)';var ic={Informacional:'background:rgba(59,111,160,.12);color:#3b6fa0',Comercial:'background:rgba(217,119,6,.12);color:#d97706',Transaccional:'background:rgba(13,110,91,.12);color:#0d6e5b',Navegacional:'background:rgba(90,109,148,.12);color:#5a6d94'}[k.intent]||'';
return '<tr><td>'+k.kw+'</td><td><span class="pill" style="background:rgba(13,110,91,.08)">'+k.phase+'</span></td><td><span class="pill" style="'+ic+'">'+(k.intent||'')+'</span></td><td class="right mono" style="font-weight:700">'+k.clicks+'</td><td class="right mono">'+k.imp.toLocaleString()+'</td><td class="right mono">'+(k.ctr||0)+'%</td><td class="right mono" style="font-weight:700;'+pc+'">'+(k.pos||0)+'</td></tr>'}).join('')}

function tog(id,btn){var el=document.getElementById(id);if(!el)return;var o=el.classList.toggle('open');btn.innerHTML=o?'☰ Ocultar':'☰ Insight'}

function buildFilters(){
  var af=document.getElementById('archFilters');af.innerHTML=ARCHS.map(function(a){return '<button class="fbtn active" data-arch="'+a.id+'" style="border-color:'+a.color+'">'+a.icon+' '+a.name+'</button>'}).join('');
  af.querySelectorAll('.fbtn').forEach(function(b){b.addEventListener('click',function(){b.classList.toggle('active');var v=b.dataset.arch;if(aA.has(v))aA.delete(v);else aA.add(v);updateAll()})});
  var pf=document.getElementById('phaseFilters');pf.innerHTML=['all'].concat(PH).map(function(p){return '<button class="fbtn'+(p==='all'?' active':'')+'" data-phase="'+p+'">'+(p==='all'?'Todas':p.substring(0,8))+'</button>'}).join('');
  pf.querySelectorAll('.fbtn').forEach(function(b){b.addEventListener('click',function(){pf.querySelectorAll('.fbtn').forEach(function(x){x.classList.remove('active')});b.classList.add('active');aP=b.dataset.phase;updateAll()})});
}

document.addEventListener('DOMContentLoaded',function(){buildFilters();initCharts();updateAll();
document.getElementById('kwSearch').addEventListener('input',function(e){sT=e.target.value;updateAll()});
document.querySelector('#kwTable thead').addEventListener('click',function(e){var th=e.target.closest('th');if(!th)return;var c=th.dataset.col;if(sC===c)sD*=-1;else{sC=c;sD=['kw','intent','phase'].indexOf(c)!==-1?1:-1}updateAll()})});
<\/script></body></html>`;
}
