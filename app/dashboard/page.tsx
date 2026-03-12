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
  const [aiRecs, setAiRecs] = useState<any[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Redirect if not authenticated
  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

  // Load available properties
  useEffect(() => {
    if (status !== "authenticated") return;
    Promise.all([
      fetch("/api/gsc?action=sites").then((r) => r.json()),
      fetch("/api/ga4?action=accounts").then((r) => r.json()),
      fetch("/api/insights").then((r) => r.json()),
    ]).then(([gsc, ga4, ai]) => {
      const sites = (gsc.siteEntry || []).map((s: any) => ({
        siteUrl: s.siteUrl,
        permissionLevel: s.permissionLevel,
      }));
      setGscSites(sites);
      if (sites.length) setSelectedGsc(sites[0].siteUrl);

      const props: Ga4Prop[] = [];
      (ga4.accountSummaries || []).forEach((acc: any) => {
        (acc.propertySummaries || []).forEach((p: any) => {
          props.push({
            property: p.property?.replace("properties/", "") || "",
            displayName: p.displayName || p.property,
            parent: acc.displayName || acc.name,
          });
        });
      });
      setGa4Props(props);
      if (props.length) setSelectedGa4(props[0].property);

      setAiEnabled(ai.enabled);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [status]);

  // Fetch data when properties are selected
  const fetchData = useCallback(async () => {
    if (!selectedGsc || !selectedGa4) return;
    setDataLoading(true);

    try {
      const [kwRes, pageGscRes, pageGa4Res] = await Promise.all([
        fetch(`/api/gsc?action=keywords&site=${encodeURIComponent(selectedGsc)}`).then((r) => r.json()),
        fetch(`/api/gsc?action=pages&site=${encodeURIComponent(selectedGsc)}`).then((r) => r.json()),
        fetch(`/api/ga4?action=pages&property=${selectedGa4}`).then((r) => r.json()),
      ]);

      const keywords = (kwRes.rows || []).map((r: any) => ({
        kw: r.keys[0],
        clicks: r.clicks,
        imp: r.impressions,
        ctr: +(r.ctr * 100).toFixed(2),
        pos: +r.position.toFixed(1),
      }));

      const gscPages = (pageGscRes.rows || []).map((r: any) => ({
        page: r.keys[0],
        clicks: r.clicks,
        imp: r.impressions,
        ctr: +(r.ctr * 100).toFixed(2),
        pos: +r.position.toFixed(1),
      }));

      const ga4Pages = (pageGa4Res.rows || []).map((r: any) => ({
        page: r.dimensionValues[0].value,
        sessions: +r.metricValues[0].value,
        engaged: +r.metricValues[1].value,
        duration: +parseFloat(r.metricValues[2].value).toFixed(0),
        purchases: +r.metricValues[3].value,
        revenue: +parseFloat(r.metricValues[4].value).toFixed(2),
      }));

      // Calculate totals
      const totalRevenue = ga4Pages.reduce((s: number, p: any) => s + p.revenue, 0);
      const totalPurchases = ga4Pages.reduce((s: number, p: any) => s + p.purchases, 0);
      const totalSessions = ga4Pages.reduce((s: number, p: any) => s + p.sessions, 0);

      const data = {
        domain: selectedGsc.replace("sc-domain:", "").replace("https://", "").replace("http://", ""),
        keywords,
        gscPages,
        ga4Pages,
        revenue: { total: totalRevenue.toFixed(0), transactions: totalPurchases, sessions: totalSessions },
      };

      setDashData(data);
      setDataLoading(false);

      // Auto-fetch AI insights if enabled
      if (aiEnabled) {
        fetchInsights(data);
      }
    } catch (err) {
      console.error("Error fetching data:", err);
      setDataLoading(false);
    }
  }, [selectedGsc, selectedGa4, aiEnabled]);

  const fetchInsights = async (data: any) => {
    setAiLoading(true);
    try {
      const res = await fetch("/api/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: data.domain,
          keywords: data.keywords,
          pages: data.ga4Pages,
          revenue: data.revenue,
        }),
      });
      const json = await res.json();
      if (json.recommendations) setAiRecs(json.recommendations);
    } catch (err) {
      console.error("Error fetching insights:", err);
    }
    setAiLoading(false);
  };

  // Generate dashboard HTML with live data
  useEffect(() => {
    if (!dashData || !iframeRef.current) return;
    const html = generateDashboardHTML(dashData, aiRecs, aiEnabled, aiLoading);
    iframeRef.current.srcdoc = html;
  }, [dashData, aiRecs, aiEnabled, aiLoading]);

  if (status === "loading" || loading) {
    return (
      <div className="loading-wrap">
        <div className="spinner"></div>
        Cargando propiedades de Google...
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Property selector bar */}
      <div className="prop-selector">
        <div>
          <label>Search Console: </label>
          <select value={selectedGsc} onChange={(e) => setSelectedGsc(e.target.value)}>
            {gscSites.map((s) => (
              <option key={s.siteUrl} value={s.siteUrl}>
                {s.siteUrl} ({s.permissionLevel})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Analytics: </label>
          <select value={selectedGa4} onChange={(e) => setSelectedGa4(e.target.value)}>
            {ga4Props.map((p) => (
              <option key={p.property} value={p.property}>
                {p.displayName} ({p.property})
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={fetchData}
          disabled={dataLoading}
          style={{
            padding: "0.4rem 1.2rem",
            borderRadius: 8,
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: "0.8rem",
            fontWeight: 600,
            cursor: dataLoading ? "wait" : "pointer",
            opacity: dataLoading ? 0.6 : 1,
          }}
        >
          {dataLoading ? "Cargando datos..." : "▶ Generar Dashboard"}
        </button>
        <span className={`ai-badge ${aiEnabled ? "on" : "off"}`}>
          {aiEnabled ? "🤖 IA ON" : "🤖 IA OFF"}
        </span>
        <button className="logout-btn" onClick={() => signOut({ callbackUrl: "/" })}>
          Cerrar sesión
        </button>
      </div>

      {/* Dashboard iframe */}
      {!dashData ? (
        <div className="loading-wrap" style={{ flex: 1 }}>
          <div style={{ textAlign: "center", color: "var(--text2)" }}>
            <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>📊</div>
            <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem" }}>
              Selecciona tus propiedades y pulsa &quot;Generar Dashboard&quot;
            </div>
            <div style={{ fontSize: "0.8rem" }}>
              Los datos se obtienen en directo de Search Console y Analytics
            </div>
          </div>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          style={{ flex: 1, border: "none", width: "100%", minHeight: "calc(100vh - 60px)" }}
          title="Customer Journey Dashboard"
        />
      )}
    </div>
  );
}

function generateDashboardHTML(data: any, aiRecs: any[], aiEnabled: boolean, aiLoading: boolean): string {
  // We inject the real data into the Loyola-style dashboard template
  const kwJSON = JSON.stringify(data.keywords.slice(0, 100));
  const pagesJSON = JSON.stringify(data.ga4Pages.slice(0, 50));
  const recsJSON = JSON.stringify(aiRecs || []);

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#f0f4f3;--surface:#fff;--surface2:#f5f8f7;--surface3:#eaf0ee;--border:#cdd9d4;--text:#0f2b2a;--text2:#4a5e5c;--text3:#7a9190;--accent:#0d6e5b;--gold:#00b4d8;--danger:#b91c1c;--warn:#d97706;--success:#0d6e5b;--radius:12px;--a1:#00b4d8;--a2:#0d6e5b;--a3:#d97706;--a4:#7c3aed}
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
.dashboard{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;padding:1.5rem 2rem;max-width:1600px;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;box-shadow:0 1px 3px rgba(13,110,91,.06)}
.card.full{grid-column:1/-1}
.card-title{font-size:.76rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text2);margin-bottom:.75rem;display:flex;align-items:center;gap:.4rem}
.card-title .dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
.chart-wrap{position:relative;height:300px}
.kw-table{width:100%;border-collapse:collapse;font-size:.74rem}
.kw-table th{background:var(--surface2);padding:.45rem;text-align:left;font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);border-bottom:1px solid var(--border)}
.kw-table td{padding:.4rem;border-bottom:1px solid rgba(13,110,91,.08)}
.kw-table tr:hover td{background:rgba(13,110,91,.04)}
.pill{display:inline-block;padding:.1rem .4rem;border-radius:4px;font-size:.6rem;font-weight:600}
.ai-card{background:rgba(0,180,216,.04);border:1px solid rgba(0,180,216,.2);border-radius:10px;padding:.85rem;margin-bottom:.6rem}
.ai-card .ai-title{font-size:.78rem;font-weight:700;color:var(--text);margin-bottom:.2rem;display:flex;align-items:center;gap:.4rem}
.ai-card .ai-desc{font-size:.68rem;color:var(--text2);line-height:1.4}
.ai-card .ai-meta{display:flex;gap:.5rem;margin-top:.4rem;flex-wrap:wrap}
.ai-card .ai-tag{font-size:.58rem;padding:.12rem .4rem;border-radius:4px;font-weight:600}
.ai-placeholder{text-align:center;padding:2rem;color:var(--text3);font-size:.8rem}
@media(max-width:1100px){.dashboard{grid-template-columns:1fr}}
@media(max-width:768px){.dashboard{padding:1rem;gap:.75rem}.card{padding:.85rem}header{padding:1.5rem 1rem}}
</style></head><body>
<header>
  <h1>Customer Journey SEO — ${data.domain}</h1>
  <p>Datos en vivo · GSC + GA4 · Últimos 28-30 días</p>
</header>
<div class="kpi-strip">
  <div class="kpi"><div class="kpi-val">${data.keywords.length}</div><div class="kpi-label">Keywords GSC</div></div>
  <div class="kpi"><div class="kpi-val">${data.keywords.reduce((s:number,k:any)=>s+k.clicks,0).toLocaleString()}</div><div class="kpi-label">Clicks totales</div></div>
  <div class="kpi"><div class="kpi-val">${data.keywords.reduce((s:number,k:any)=>s+k.imp,0).toLocaleString()}</div><div class="kpi-label">Impresiones</div></div>
  <div class="kpi"><div class="kpi-val gold">€${Number(data.revenue.total).toLocaleString()}</div><div class="kpi-label">Revenue 30d</div></div>
  <div class="kpi"><div class="kpi-val">${data.revenue.transactions}</div><div class="kpi-label">Transacciones</div></div>
  <div class="kpi"><div class="kpi-val">${data.revenue.sessions.toLocaleString()}</div><div class="kpi-label">Sesiones GA4</div></div>
</div>
<div class="dashboard">
  <div class="card"><div class="card-title"><span class="dot"></span>Top Keywords · Impresiones vs Posición</div><div class="chart-wrap"><canvas id="bubbleChart"></canvas></div></div>
  <div class="card"><div class="card-title"><span class="dot"></span>Top Páginas por Revenue</div><div class="chart-wrap"><canvas id="revenueBar"></canvas></div></div>
  <div class="card full"><div class="card-title"><span class="dot" style="background:var(--gold)"></span>🤖 Recomendaciones IA ${aiEnabled ? (aiLoading ? '· Generando...' : '· '+aiRecs.length+' insights') : '· No configurado'}</div>
    <div id="aiContent">${aiEnabled ? (aiLoading ? '<div class="ai-placeholder"><div class="spinner" style="display:inline-block;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px"></div>Claude está analizando tus datos...</div>' : (aiRecs.length ? '' : '<div class="ai-placeholder">Pulsa "Generar Dashboard" para obtener recomendaciones de IA</div>')) : '<div class="ai-placeholder">Añade ANTHROPIC_API_KEY en Vercel para activar las recomendaciones de IA.<br>El dashboard funciona perfectamente sin ella — solo falta esta capa.</div>'}</div>
  </div>
  <div class="card full"><div class="card-title"><span class="dot"></span>Keywords GSC · Top ${Math.min(data.keywords.length, 50)}</div>
    <div style="max-height:500px;overflow-y:auto">
    <table class="kw-table"><thead><tr><th>Keyword</th><th style="text-align:right">Clicks</th><th style="text-align:right">Imp</th><th style="text-align:right">CTR</th><th style="text-align:right">Pos</th></tr></thead>
    <tbody>${data.keywords.slice(0,50).map((k:any)=>{
      const pc = k.pos<=5?'color:var(--success)':k.pos<=10?'color:var(--warn)':'color:var(--danger)';
      return '<tr><td>'+k.kw+'</td><td class="mono" style="text-align:right;font-weight:600">'+k.clicks+'</td><td class="mono" style="text-align:right">'+k.imp.toLocaleString()+'</td><td class="mono" style="text-align:right">'+k.ctr+'%</td><td class="mono" style="text-align:right;font-weight:700;'+pc+'">'+k.pos+'</td></tr>';
    }).join('')}</tbody></table></div>
  </div>
  <div class="card full"><div class="card-title"><span class="dot"></span>Páginas GA4 · Top ${Math.min(data.ga4Pages.length, 30)}</div>
    <div style="max-height:500px;overflow-y:auto">
    <table class="kw-table"><thead><tr><th>Página</th><th style="text-align:right">Sesiones</th><th style="text-align:right">Engaged</th><th style="text-align:right">Revenue</th><th style="text-align:right">Compras</th></tr></thead>
    <tbody>${data.ga4Pages.slice(0,30).map((p:any)=>{
      const rev = p.revenue > 0 ? '<span style="color:var(--success);font-weight:700">€'+p.revenue.toLocaleString()+'</span>' : '<span style="color:var(--text3)">—</span>';
      return '<tr><td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+p.page+'</td><td class="mono" style="text-align:right">'+p.sessions.toLocaleString()+'</td><td class="mono" style="text-align:right">'+p.engaged.toLocaleString()+'</td><td style="text-align:right">'+rev+'</td><td class="mono" style="text-align:right">'+(p.purchases||'—')+'</td></tr>';
    }).join('')}</tbody></table></div>
  </div>
</div>
<script>
const KW = ${kwJSON};
const PAGES = ${pagesJSON};
const RECS = ${recsJSON};

Chart.defaults.color='#4a5e5c';
Chart.defaults.font.family="'DM Sans',sans-serif";
Chart.defaults.font.size=11;

// Bubble chart: impressions vs position
const top30 = KW.slice(0,30);
new Chart(document.getElementById('bubbleChart'),{
  type:'bubble',
  data:{datasets:[{
    data: top30.map(k=>({x:k.pos, y:k.imp, r:Math.max(3, Math.sqrt(k.clicks/5)*3), label:k.kw})),
    backgroundColor:'rgba(13,110,91,0.5)',
    borderColor:'#0d6e5b',
    borderWidth:1
  }]},
  options:{responsive:true,maintainAspectRatio:false,
    scales:{
      x:{title:{display:true,text:'Posición media →'},grid:{color:'rgba(13,110,91,.08)'},min:0,max:Math.max(...top30.map(k=>k.pos))+5},
      y:{title:{display:true,text:'← Impresiones'},grid:{color:'rgba(13,110,91,.08)'},min:0}
    },
    plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>{const d=c.raw;return[d.label,'Imp: '+d.y.toLocaleString()+' | Pos: '+d.x,'Clicks: '+KW[c.dataIndex]?.clicks]}}}}
  }
});

// Revenue bar chart
const revPages = PAGES.filter(p=>p.revenue>0).slice(0,10);
new Chart(document.getElementById('revenueBar'),{
  type:'bar',
  data:{
    labels:revPages.map(p=>p.page.replace(/^\\//, '').substring(0,35)+'...'),
    datasets:[{data:revPages.map(p=>p.revenue),backgroundColor:'#0d6e5bcc',borderRadius:4}]
  },
  options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',
    scales:{x:{grid:{color:'rgba(13,110,91,.08)'},title:{display:true,text:'Revenue €'}},y:{grid:{display:false}}},
    plugins:{legend:{display:false}}
  }
});

// Render AI recommendations
if(RECS.length){
  const el = document.getElementById('aiContent');
  const prioColor = {ALTA:'var(--danger)',MEDIA:'var(--warn)',BAJA:'var(--success)'};
  const typeColor = {SEO:'rgba(13,110,91,.12)',CONTENIDO:'rgba(217,119,6,.12)',TÉCNICO:'rgba(185,28,28,.12)',CRO:'rgba(0,180,216,.12)',ENLAZADO:'rgba(124,58,237,.12)'};
  const typeText = {SEO:'var(--success)',CONTENIDO:'var(--warn)',TÉCNICO:'var(--danger)',CRO:'var(--gold)',ENLAZADO:'#7c3aed'};
  el.innerHTML = RECS.map(r=>'<div class="ai-card" style="border-left:3px solid '+(prioColor[r.priority]||'var(--accent)')+'"><div class="ai-title">'+r.title+'</div><div class="ai-desc">'+r.description+'</div><div class="ai-meta"><span class="ai-tag" style="background:'+(typeColor[r.type]||'rgba(13,110,91,.08)')+';color:'+(typeText[r.type]||'var(--text2)')+'">'+r.type+'</span><span class="ai-tag" style="background:rgba(185,28,28,.08);color:var(--danger)">'+r.priority+'</span><span class="ai-tag" style="background:rgba(13,110,91,.08);color:var(--text2)">'+r.phase+'</span><span class="ai-tag" style="background:rgba(0,180,216,.08);color:var(--gold)">'+r.impact+'</span><span class="ai-tag" style="background:rgba(122,145,144,.08);color:var(--text3)">⏱ '+r.effort+'</span></div></div>').join('');
}
</${'script'}></body></html>`;
}
