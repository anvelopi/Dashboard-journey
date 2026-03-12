"use client";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";

type GscSite = { siteUrl: string; permissionLevel: string };
type Ga4Prop = { property: string; displayName: string; parent: string };
type Competitor = { domain: string; active: boolean; source: string; etv: number; count: number; cost: number; top10: number; avgPos: number; shared: number; type: string };

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

  // ═══ NEW: Competitor state ═══
  const [step, setStep] = useState<"select"|"competitors"|"dashboard">("select");
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [domainOverview, setDomainOverview] = useState<any>(null);
  const [compLoading, setCompLoading] = useState(false);
  const [compInput, setCompInput] = useState("");
  const [compGaps, setCompGaps] = useState<Record<string,any[]>>({});
  const [compShared, setCompShared] = useState<Record<string,any[]>>({});

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

  // ═══ STEP 2: Discover competitors ═══
  const discoverCompetitors = useCallback(async () => {
    if (!selectedGsc) return;
    setCompLoading(true);
    const domain = selectedGsc.replace("sc-domain:", "").replace(/https?:\/\//, "").replace(/\/$/, "").replace(/^www\./, "");
    try {
      const res = await fetch("/api/dataforseo", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discover", domain }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDomainOverview(data.domain);
      setCompetitors(data.competitors || []);
      setStep("competitors");
    } catch (err: any) {
      console.error("Discover error:", err);
      // Fallback: skip to dashboard without competitors
      setStep("competitors");
    }
    setCompLoading(false);
  }, [selectedGsc]);

  function toggleComp(d: string) { setCompetitors(prev => prev.map(c => c.domain === d ? { ...c, active: !c.active } : c)); }
  function addComp() {
    const d = compInput.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (!d || !d.includes(".") || competitors.find(c => c.domain === d)) return;
    setCompetitors(prev => [...prev, { domain: d, active: true, source: "manual", etv: 0, count: 0, cost: 0, top10: 0, avgPos: 0, shared: 0, type: "Unknown" }]);
    setCompInput("");
  }
  function removeComp(d: string) { setCompetitors(prev => prev.filter(c => c.domain !== d)); }

  // ═══ STEP 3: Fetch all data and generate ═══
  const fetchData = useCallback(async () => {
    if (!selectedGsc || !selectedGa4) return;
    setDataLoading(true);
    setJourney(null);
    setStep("dashboard");
    const domain = selectedGsc.replace("sc-domain:", "").replace(/https?:\/\//, "").replace(/\/$/, "").replace(/^www\./, "");
    const activeComps = competitors.filter(c => c.active);

    try {
      // Parallel: GSC + GA4 + competitor gaps
      const [kwRes, pageGa4Res, ...compResults] = await Promise.all([
        fetch("/api/gsc?action=keywords&site=" + encodeURIComponent(selectedGsc)).then(r => r.json()),
        fetch("/api/ga4?action=pages&property=" + selectedGa4).then(r => r.json()),
        ...activeComps.map(c =>
          fetch("/api/dataforseo", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "gap", domain, competitorDomain: c.domain }) }).then(r => r.json()).catch(() => ({ gaps: [] }))
        ),
      ]);

      const keywords = (kwRes.rows || []).map((r: any) => ({
        kw: r.keys[0], clicks: r.clicks, imp: r.impressions, ctr: +(r.ctr * 100).toFixed(2), pos: +r.position.toFixed(1),
      }));
      const ga4Pages = (pageGa4Res.rows || []).map((r: any) => ({
        page: r.dimensionValues[0].value, sessions: +r.metricValues[0].value, engaged: +r.metricValues[1].value,
        duration: +parseFloat(r.metricValues[2].value).toFixed(0), purchases: +r.metricValues[3].value, revenue: +parseFloat(r.metricValues[4].value).toFixed(2),
      }));

      // Collect gaps per competitor
      const gaps: Record<string, any[]> = {};
      activeComps.forEach((c, i) => { gaps[c.domain] = compResults[i]?.gaps || []; });
      setCompGaps(gaps);

      // Also fetch shared keywords for active competitors
      const sharedResults = await Promise.all(
        activeComps.map(c =>
          fetch("/api/dataforseo", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "shared", domain, competitorDomain: c.domain }) }).then(r => r.json()).catch(() => ({ shared: [] }))
        )
      );
      const shared: Record<string, any[]> = {};
      activeComps.forEach((c, i) => { shared[c.domain] = sharedResults[i]?.shared || []; });
      setCompShared(shared);

      const totalRevenue = ga4Pages.reduce((s: number, p: any) => s + p.revenue, 0);
      const totalPurchases = ga4Pages.reduce((s: number, p: any) => s + p.purchases, 0);
      const totalSessions = ga4Pages.reduce((s: number, p: any) => s + p.sessions, 0);

      const data = {
        domain, keywords, ga4Pages,
        revenue: { total: totalRevenue.toFixed(0), transactions: totalPurchases, sessions: totalSessions },
        competitors: activeComps, compGaps: gaps, compShared: shared, domainOverview,
      };
      setDashData(data);
      setDataLoading(false);
      if (aiEnabled) fetchInsights(data);
    } catch (err) { console.error(err); setDataLoading(false); }
  }, [selectedGsc, selectedGa4, aiEnabled, competitors, domainOverview]);

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

  const activeCount = competitors.filter(c => c.active).length;
  const manualCount = competitors.filter(c => c.source === "manual").length;

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

        {step === "select" && (
          <button onClick={discoverCompetitors} disabled={compLoading} style={{
            padding: "0.4rem 1.2rem", borderRadius: 8, border: "none", background: "#0d6e5b", color: "#fff",
            fontFamily: "'DM Sans',sans-serif", fontSize: "0.8rem", fontWeight: 600, cursor: compLoading ? "wait" : "pointer", opacity: compLoading ? 0.6 : 1,
          }}>{compLoading ? "Descubriendo competidores..." : "▶ Configurar competidores"}</button>
        )}
        {step === "competitors" && (
          <button onClick={fetchData} disabled={dataLoading} style={{
            padding: "0.4rem 1.2rem", borderRadius: 8, border: "none", background: "#0d6e5b", color: "#fff",
            fontFamily: "'DM Sans',sans-serif", fontSize: "0.8rem", fontWeight: 600, cursor: dataLoading ? "wait" : "pointer", opacity: dataLoading ? 0.6 : 1,
          }}>{dataLoading ? "Generando..." : `▶ Generar Dashboard (${activeCount} comp.)`}</button>
        )}
        {step === "dashboard" && (
          <button onClick={() => setStep("competitors")} style={{
            padding: "0.4rem 1.2rem", borderRadius: 8, border: "1px solid #cdd9d4", background: "transparent", color: "#4a5e5c",
            fontFamily: "'DM Sans',sans-serif", fontSize: "0.8rem", fontWeight: 600, cursor: "pointer",
          }}>⚙️ Competidores</button>
        )}

        <span className={"ai-badge " + (aiEnabled ? "on" : "off")}>{aiEnabled ? "🤖 IA ON" : "🤖 IA OFF"}</span>
        <button className="logout-btn" onClick={() => signOut({ callbackUrl: "/" })}>Cerrar sesión</button>
      </div>

      {/* ═══ STEP 2: COMPETITOR MANAGER ═══ */}
      {step === "competitors" && (
        <div style={{ padding: "1.5rem 2rem", maxWidth: 900, margin: "0 auto", width: "100%" }}>
          {domainOverview && (
            <div style={{ background: "rgba(13,110,91,.06)", border: "1px solid rgba(13,110,91,.15)", borderRadius: 12, padding: "1rem 1.2rem", marginBottom: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#0d6e5b" }}></span>
                <strong style={{ fontSize: ".85rem" }}>Tu dominio</strong>
              </div>
              <div style={{ display: "flex", gap: 24, fontSize: ".8rem", color: "#4a5e5c" }}>
                <span>ETV: <strong>{domainOverview.etv?.toLocaleString()}</strong></span>
                <span>KWs: <strong>{domainOverview.count?.toLocaleString()}</strong></span>
                <span>Top 10: <strong>{domainOverview.top10}</strong></span>
              </div>
            </div>
          )}

          <div style={{ background: "#fff", border: "1px solid #cdd9d4", borderRadius: 12, padding: "1.2rem", marginBottom: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <strong style={{ fontSize: ".8rem", color: "#4a5e5c", textTransform: "uppercase", letterSpacing: ".06em" }}>Competidores</strong>
              <span style={{ fontSize: ".7rem", color: "#7a9190" }}>{manualCount}/5 manuales · {activeCount} activos</span>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input type="text" value={compInput} onChange={e => setCompInput(e.target.value)} onKeyDown={e => e.key === "Enter" && addComp()}
                placeholder="Añadir competidor manual..." disabled={manualCount >= 5}
                style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid #cdd9d4", background: "#f5f8f7", fontSize: ".82rem", fontFamily: "'DM Sans',sans-serif", outline: "none" }} />
              <button onClick={addComp} disabled={manualCount >= 5}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#0d6e5b", color: "#fff", fontSize: ".82rem", fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>+ Añadir</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}>
              {competitors.map((c, i) => (
                <div key={c.domain} onClick={() => toggleComp(c.domain)} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderRadius: 8,
                  border: `1px solid ${c.active ? "rgba(13,110,91,.3)" : "#cdd9d4"}`, background: c.active ? "rgba(13,110,91,.04)" : "#f5f8f7",
                  cursor: "pointer", opacity: c.active ? 1 : 0.5, transition: "all .15s",
                }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: ".82rem", fontWeight: 600 }}>{c.domain}</span>
                      <span style={{ fontSize: ".55rem", padding: "1px 5px", borderRadius: 3, fontWeight: 700, background: c.source === "manual" ? "rgba(13,110,91,.12)" : "rgba(0,0,0,.06)", color: c.source === "manual" ? "#0d6e5b" : "#7a9190" }}>{c.source === "manual" ? "MANUAL" : "AUTO"}</span>
                      {c.type !== "Unknown" && <span style={{ fontSize: ".55rem", color: "#7a9190" }}>{c.type}</span>}
                    </div>
                    {c.etv > 0 && <div style={{ display: "flex", gap: 16, fontSize: ".7rem", color: "#7a9190", marginTop: 3 }}>
                      <span>ETV: {c.etv.toLocaleString()}</span><span>KWs: {c.count.toLocaleString()}</span><span>Shared: {c.shared}</span>
                    </div>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${c.active ? "#0d6e5b" : "#ccc"}`, background: c.active ? "#0d6e5b" : "transparent", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: ".65rem" }}>
                      {c.active && "✓"}
                    </div>
                    {c.source === "manual" && <button onClick={e => { e.stopPropagation(); removeComp(c.domain); }} style={{ width: 20, height: 20, borderRadius: 4, border: "1px solid rgba(185,28,28,.2)", background: "transparent", color: "#b91c1c", display: "flex", alignItems: "center", justifyContent: "center", fontSize: ".65rem", cursor: "pointer" }}>✕</button>}
                  </div>
                </div>
              ))}
              {competitors.length === 0 && <div style={{ textAlign: "center", padding: 20, color: "#7a9190", fontSize: ".82rem" }}>
                {compLoading ? "Descubriendo competidores con DataForSEO..." : "No se encontraron competidores. Añade uno manualmente."}
              </div>}
            </div>
          </div>
        </div>
      )}

      {/* ═══ DASHBOARD (iframe) ═══ */}
      {step === "dashboard" && !dashData && (
        <div className="loading-wrap" style={{ flex: 1 }}>
          <div style={{ textAlign: "center", color: "#4a5e5c" }}>
            <div className="spinner" style={{ margin: "0 auto 1rem" }}></div>
            <div style={{ fontSize: ".9rem", fontWeight: 600 }}>Generando Customer Journey Dashboard...</div>
            <div style={{ fontSize: ".75rem", color: "#7a9190", marginTop: 4 }}>GSC + GA4 + DataForSEO + Claude IA</div>
          </div>
        </div>
      )}
      {step === "dashboard" && dashData && (
        <iframe ref={iframeRef} style={{ flex: 1, border: "none", width: "100%", minHeight: "calc(100vh - 60px)" }} title="Dashboard" />
      )}

      {/* ═══ INITIAL STATE ═══ */}
      {step === "select" && (
        <div className="loading-wrap" style={{ flex: 1 }}>
          <div style={{ textAlign: "center", color: "#4a5e5c" }}>
            <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>📊</div>
            <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem" }}>Selecciona tus propiedades y pulsa &quot;Configurar competidores&quot;</div>
            <div style={{ fontSize: "0.8rem" }}>El sistema descubrirá automáticamente tus competidores orgánicos con DataForSEO</div>
          </div>
        </div>
      )}
    </div>
  );
}


function generateDashboardHTML(data: any, journey: any, aiEnabled: boolean, aiLoading: boolean): string {
  const PH = ["Descubrimiento","Investigación","Evaluación","Decisión","Compra","Post-venta"];
  const PCS = ["#0d6e5b","#0a5a49","#087a5e","#00b4d8","#d97706","#b91c1c"];
  const defaultColors: Record<string,string> = {A1:"#00b4d8",A2:"#0d6e5b",A3:"#d97706",A4:"#7c3aed"};
  const COMP_COLORS = ["#be123c","#059669","#d97706","#6366f1","#f97316"];

  const kws = journey?.keywords_classified || data.keywords.slice(0,60).map((k:any,i:number)=>({
    ...k, phase: PH[Math.min(Math.floor(i/10),5)], intent: "Informacional", archs: ["A1"]
  }));
  const archs = journey?.archetypes || [
    {id:"A1",name:"Perfil 1",icon:"\ud83d\udc64",desc:"Cargando an\u00e1lisis IA...",pct:25,color:"#00b4d8"},
    {id:"A2",name:"Perfil 2",icon:"\ud83d\udc64",desc:"Cargando an\u00e1lisis IA...",pct:25,color:"#0d6e5b"},
    {id:"A3",name:"Perfil 3",icon:"\ud83d\udc64",desc:"Cargando an\u00e1lisis IA...",pct:25,color:"#d97706"},
    {id:"A4",name:"Perfil 4",icon:"\ud83d\udc64",desc:"Cargando an\u00e1lisis IA...",pct:25,color:"#7c3aed"},
  ];
  const pains = journey?.pain_points || [];
  const gaps = journey?.content_gaps || [];
  const recs = journey?.recommendations || [];
  const ins = journey?.insights || {};

  // Competitor data
  const activeComps = data.competitors || [];
  const compGaps = data.compGaps || {};
  const compShared = data.compShared || {};
  const domOvw = data.domainOverview || {};

  const kwsJSON = JSON.stringify(kws);
  const archsJSON = JSON.stringify(archs);
  const painsJSON = JSON.stringify(pains);
  const gapsJSON = JSON.stringify(gaps);
  const recsJSON = JSON.stringify(recs);
  const insJSON = JSON.stringify(ins);
  const pagesJSON = JSON.stringify(data.ga4Pages?.slice(0,30) || []);
  const compsJSON = JSON.stringify(activeComps);
  const compGapsJSON = JSON.stringify(compGaps);
  const compSharedJSON = JSON.stringify(compShared);
  const domOvwJSON = JSON.stringify(domOvw);

  // Build SoV section HTML
  let sovHTML = "";
  if (activeComps.length > 0) {
    sovHTML = `
    <div class="card full" id="compSection">
      <div class="card-title"><span class="dot" style="background:#00b4d8"></span>Competidores \u2014 Share of Voice + Detalle</div>
      <div style="margin-bottom:12px">
        <table style="width:100%;border-collapse:collapse;font-size:.74rem">
          <tr style="background:rgba(13,110,91,.06)"><th style="text-align:left;padding:6px 8px;font-size:.62rem;text-transform:uppercase;color:#4a5e5c">Dominio</th><th style="text-align:right;padding:6px 8px;font-size:.62rem;text-transform:uppercase;color:#4a5e5c">ETV</th><th style="text-align:right;padding:6px 8px;font-size:.62rem;text-transform:uppercase;color:#4a5e5c">KWs</th><th style="text-align:right;padding:6px 8px;font-size:.62rem;text-transform:uppercase;color:#4a5e5c">Shared</th><th style="text-align:right;padding:6px 8px;font-size:.62rem;text-transform:uppercase;color:#4a5e5c">vs T\u00fa</th></tr>
          <tr style="background:rgba(13,110,91,.04)"><td style="padding:6px 8px;font-weight:700">${data.domain}</td><td style="text-align:right;padding:6px 8px;font-family:'Space Mono',monospace">${(domOvw.etv||0).toLocaleString()}</td><td style="text-align:right;padding:6px 8px;font-family:'Space Mono',monospace">${(domOvw.count||0).toLocaleString()}</td><td style="text-align:right;padding:6px 8px">\u2014</td><td style="text-align:right;padding:6px 8px"><span style="font-size:.6rem;padding:1px 5px;border-radius:3px;background:rgba(13,110,91,.1);color:#0d6e5b;font-weight:700">T\u00da</span></td></tr>
          ${activeComps.map((c: any, i: number) => `<tr style="cursor:pointer" onclick="toggleDetail('${c.domain}')"><td style="padding:6px 8px"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${COMP_COLORS[i % COMP_COLORS.length]};margin-right:5px"></span>${c.domain}</td><td style="text-align:right;padding:6px 8px;font-family:'Space Mono',monospace">${(c.etv||0).toLocaleString()}</td><td style="text-align:right;padding:6px 8px;font-family:'Space Mono',monospace">${(c.count||0).toLocaleString()}</td><td style="text-align:right;padding:6px 8px;font-family:'Space Mono',monospace">${(c.shared||0).toLocaleString()}</td><td style="text-align:right;padding:6px 8px"><span style="font-size:.6rem;padding:1px 5px;border-radius:3px;background:rgba(185,28,28,.08);color:#b91c1c;font-weight:700">${domOvw.etv ? (c.etv / domOvw.etv).toFixed(1) : '?'}\u00d7</span></td></tr>`).join("")}
        </table>
      </div>
      <div id="compDetailArea"></div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#f0f4f3;--surface:#fff;--surface2:#f5f8f7;--surface3:#eaf0ee;--border:#cdd9d4;--text:#0f2b2a;--text2:#4a5e5c;--text3:#7a9190;--accent:#0d6e5b;--accent2:#0a5a49;--gold:#00b4d8;--gold2:#0096b4;--a1:#00b4d8;--a2:#0d6e5b;--a3:#d97706;--a4:#7c3aed;--danger:#b91c1c;--warn:#d97706;--success:#0d6e5b;--radius:12px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
.mono{font-family:'Space Mono',monospace}
.tabs-nav{display:flex;gap:2px;padding:.4rem 2rem;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto;position:sticky;top:0;z-index:10}
.tab-btn{padding:7px 14px;border-radius:7px;cursor:pointer;font-size:.72rem;font-weight:600;color:var(--text2);border:none;background:none;font-family:'DM Sans',sans-serif;white-space:nowrap;transition:all .15s}
.tab-btn:hover{color:var(--text);background:var(--surface2)}
.tab-btn.on{background:var(--text);color:#fff}
.tab-pnl{display:none;padding:1.5rem 2rem;max-width:1600px;margin:0 auto}
.tab-pnl.on{display:block}
header{background:linear-gradient(135deg,#0d6e5b,#0a5a49,#0d6e5b);border-bottom:2px solid var(--gold);padding:1.5rem 2rem;position:relative;overflow:hidden}
header::before{content:'';position:absolute;top:-50%;right:-10%;width:500px;height:500px;background:radial-gradient(circle,rgba(0,180,216,.12),transparent 70%);pointer-events:none}
header h1{font-size:1.4rem;font-weight:700;color:#fff}
header p{color:rgba(255,255,255,.65);font-size:.78rem;margin-top:.2rem}
.kpi-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.6rem;padding:.8rem 2rem;background:var(--surface);border-bottom:1px solid var(--border)}
.kpi{text-align:center;padding:.35rem}
.kpi-val{font-family:'Space Mono',monospace;font-size:1.2rem;font-weight:700;color:var(--accent)}
.kpi-val.gold{color:var(--gold)}
.kpi-label{font-size:.58rem;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;margin-top:.08rem}
.dashboard{display:grid;grid-template-columns:1fr 1fr;gap:1rem;max-width:1600px;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem;box-shadow:0 1px 3px rgba(13,110,91,.05)}
.card.full{grid-column:1/-1}
.card-title{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text2);margin-bottom:.7rem;display:flex;align-items:center;gap:.35rem}
.card-title .dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.chart-wrap{position:relative;height:280px}
.arch-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:.6rem}
.arch-card{border-radius:10px;padding:.8rem;border:1px solid var(--border);background:var(--surface2);position:relative;overflow:hidden}
.arch-card::after{content:'';position:absolute;top:0;left:0;width:100%;height:3px}
.arch-card h3{font-size:.76rem;font-weight:700;margin-bottom:.3rem}
.arch-card .desc{font-size:.62rem;color:var(--text2);line-height:1.35;margin-bottom:.35rem}
.arch-card .weight-row{display:flex;gap:.6rem;margin-top:.25rem}
.arch-card .weight-val{font-family:'Space Mono',monospace;font-size:.95rem;font-weight:700}
.arch-card .weight-lbl{font-size:.5rem;color:var(--text3);text-transform:uppercase;letter-spacing:.04em}
.heatmap{width:100%;border-collapse:separate;border-spacing:3px}
.heatmap th{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text2);padding:.35rem;text-align:center}
.heatmap th.row-h{text-align:left;font-size:.64rem;color:var(--text);max-width:120px}
.heatmap td{text-align:center;padding:.35rem .2rem;border-radius:5px;font-family:'Space Mono',monospace;font-size:.7rem;font-weight:700;transition:transform .15s}
.heatmap td:hover{transform:scale(1.05);z-index:2}
.heatmap td .sub{display:block;font-family:'DM Sans',sans-serif;font-size:.5rem;font-weight:400;opacity:.8;margin-top:1px}
.journey-map{display:grid;grid-template-columns:110px repeat(6,1fr);gap:2px;font-size:.64rem}
.jm-phase{text-align:center;padding:.35rem .1rem;font-weight:700;font-size:.56rem;text-transform:uppercase;letter-spacing:.04em;border-radius:5px 5px 0 0;color:#fff}
.jm-arch-label{display:flex;align-items:center;padding:.2rem;font-weight:600;font-size:.62rem;border-radius:5px 0 0 5px}
.jm-cell{background:var(--surface2);padding:.35rem;border-radius:3px;border:1px solid transparent;min-height:60px;transition:border-color .2s}
.jm-cell:hover{border-color:rgba(13,110,91,.3)}
.jm-cell .kw-list{list-style:none;font-size:.58rem;color:var(--text2);line-height:1.25}
.jm-cell .kw-list li{margin-bottom:.04rem}
.jm-cell .kw-list .vol{font-family:'Space Mono',monospace;font-size:.5rem;color:var(--accent)}
.jm-cell .insight-body{max-height:0;overflow:hidden;transition:max-height .3s,opacity .2s;opacity:0}
.jm-cell .insight-body.open{max-height:800px;opacity:1}
.ins-toggle{font-size:.5rem;color:var(--gold2);cursor:pointer;display:inline-flex;align-items:center;gap:.15rem;padding:.06rem .2rem;border-radius:3px;background:rgba(0,180,216,.06);border:1px solid rgba(0,180,216,.15);transition:all .2s;user-select:none;margin-top:.2rem}
.ins-toggle:hover{background:rgba(0,180,216,.12)}
.insight-body{font-size:.55rem;color:var(--text2);line-height:1.3;margin-top:.12rem;padding-top:.12rem;border-top:1px dashed rgba(0,180,216,.2)}
.insight-body .ib-s{margin-bottom:.2rem}
.insight-body .ib-l{font-weight:700;color:var(--text);font-size:.52rem;text-transform:uppercase;letter-spacing:.03em;margin-bottom:.03rem}
.insight-body .pain{color:var(--danger);font-size:.52rem}
.insight-body .gain{color:var(--success);font-size:.52rem}
.pain-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:.5rem}
.pain-card{background:var(--surface2);border-left:3px solid var(--danger);border-radius:0 8px 8px 0;padding:.55rem .75rem}
.pain-card .pt{font-size:.7rem;font-weight:600;color:var(--danger);margin-bottom:.1rem;display:flex;align-items:center;gap:.35rem}
.sev-dots{display:inline-flex;gap:2px}
.sev-dot{width:6px;height:6px;border-radius:50%;background:rgba(185,28,28,.1);border:1px solid rgba(185,28,28,.15)}
.sev-dot.on{background:var(--danger);border-color:var(--danger)}
.pain-card .pd{font-size:.62rem;color:var(--text2);line-height:1.3;margin-bottom:.15rem}
.pain-card .pm{display:flex;gap:.2rem;font-size:.52rem;color:var(--text3);flex-wrap:wrap}
.pain-card .pm span{padding:.04rem .15rem;border-radius:3px;background:rgba(13,110,91,.06)}
.gap-list{display:flex;flex-direction:column;gap:.35rem}
.gap-item{display:grid;grid-template-columns:1fr 70px;gap:.3rem;align-items:start;padding:.5rem .7rem;background:var(--surface2);border:1px solid var(--border);border-radius:7px;border-left:3px solid var(--accent)}
.gap-item .gt{font-size:.72rem;font-weight:600;color:var(--text)}
.gap-item .gk{font-size:.58rem;color:var(--text3);margin-top:.08rem}
.gap-item .gpri{text-align:right}
.gap-item .gpb{display:inline-block;padding:.08rem .3rem;border-radius:3px;font-size:.56rem;font-weight:700;text-transform:uppercase}
.gap-item .gpb.alta{background:rgba(185,28,28,.1);color:var(--danger)}
.gap-item .gpb.media{background:rgba(217,119,6,.1);color:var(--warn)}
.gap-item .gpb.baja{background:rgba(13,110,91,.1);color:var(--success)}
.rec-card{background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:.6rem .8rem;margin-bottom:.4rem}
.rec-card .rc-head{display:flex;align-items:center;gap:.3rem;margin-bottom:.2rem;flex-wrap:wrap}
.rec-card .rc-title{font-size:.74rem;font-weight:700;color:var(--text)}
.rec-card .rc-tag{font-size:.52rem;padding:.06rem .3rem;border-radius:3px;font-weight:700;text-transform:uppercase}
.rec-card .rc-desc{font-size:.64rem;color:var(--text2);line-height:1.35}
.rec-card .rc-meta{display:flex;gap:.4rem;margin-top:.25rem;font-size:.55rem;color:var(--text3);flex-wrap:wrap}
.rec-card .rc-meta span{padding:.04rem .25rem;border-radius:3px;background:rgba(13,110,91,.05)}
.kw-table-wrap{max-height:450px;overflow-y:auto;overflow-x:auto;scrollbar-width:thin}
.kw-table{width:100%;border-collapse:collapse;font-size:.7rem;min-width:600px}
.kw-table thead{position:sticky;top:0;z-index:5}
.kw-table th{background:var(--surface2);padding:.4rem .3rem;text-align:left;font-size:.58rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text2);border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap}
.kw-table th:hover{color:var(--accent)}
.kw-table td{padding:.3rem;border-bottom:1px solid rgba(13,110,91,.06);vertical-align:middle}
.kw-table tr:hover td{background:rgba(13,110,91,.03)}
.pill{display:inline-block;padding:.06rem .3rem;border-radius:3px;font-size:.56rem;font-weight:600;white-space:nowrap}
.sov-row{display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:.62rem}
.sov-label{width:100px;color:var(--text2);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sov-bar{flex:1;height:18px;background:var(--surface3);border-radius:3px;overflow:hidden;display:flex}
.sov-seg{height:100%;display:flex;align-items:center;justify-content:center;font-size:.46rem;font-weight:700;color:#fff;min-width:1px}
.sov-total{font-family:'Space Mono',monospace;font-size:.56rem;color:var(--text3);width:50px;text-align:right}
.wl-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px}
.wl-box{background:var(--surface3);border-radius:6px;padding:6px;text-align:center}
.wl-box .wl-v{font-family:'Space Mono',monospace;font-size:.95rem;font-weight:700}
.wl-box .wl-l{font-size:.48rem;color:var(--text3);text-transform:uppercase;letter-spacing:.03em}
.detail-panel{border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:8px;display:none}
.detail-panel.open{display:block}
.gap-mini{max-height:120px;overflow-y:auto;font-size:.58rem;color:var(--text2)}
.gap-mini-row{display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid rgba(0,0,0,.04)}
.method-toggle{cursor:pointer;display:flex;align-items:center;gap:.3rem;padding:.3rem .5rem;border-radius:5px;border:1px solid var(--border);background:var(--surface2);font-size:.68rem;font-weight:600;color:var(--text2);transition:all .2s;user-select:none;margin-bottom:.3rem}
.method-toggle:hover{border-color:rgba(13,110,91,.2);color:var(--text)}
.method-body{max-height:0;overflow:hidden;transition:max-height .4s,opacity .3s;opacity:0;font-size:.68rem;color:var(--text2);line-height:1.45}
.method-body.open{max-height:50000px;opacity:1}
.method-body p{margin-bottom:.3rem}
.ai-loading{text-align:center;padding:1.5rem;color:var(--text3)}
.ai-loading .spinner{display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.filters{display:flex;gap:.4rem;padding:.6rem 2rem;flex-wrap:wrap;align-items:center;background:var(--surface);border-bottom:1px solid var(--border)}
.filters label{font-size:.65rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin-right:.15rem}
.filter-group{display:flex;gap:.25rem;align-items:center;margin-right:.75rem}
.fbtn{padding:.2rem .45rem;border-radius:5px;border:1px solid var(--border);background:transparent;color:var(--text2);font-family:'DM Sans',sans-serif;font-size:.68rem;cursor:pointer;transition:all .12s}
.fbtn:hover{border-color:var(--accent);color:var(--text)}
.fbtn.active{background:var(--accent);border-color:var(--accent);color:#fff}
.search-box{padding:.3rem .5rem;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-family:'DM Sans',sans-serif;font-size:.76rem;width:160px;outline:none}
.search-box:focus{border-color:var(--accent)}
@media(max-width:1100px){.dashboard{grid-template-columns:1fr}.arch-cards{grid-template-columns:repeat(2,1fr)}}
@media(max-width:768px){.tabs-nav{padding:.3rem 1rem}.tab-pnl{padding:1rem}.dashboard{gap:.6rem}.arch-cards{grid-template-columns:1fr 1fr}.journey-map{min-width:900px}}
</style></head><body>
<header>
  <h1>Customer Journey SEO \u2014 ${data.domain}</h1>
  <p>${archs.length} arquetipos \u00d7 6 fases \u00d7 ${kws.length} keywords GSC + ${activeComps.length} competidores${aiEnabled ? " + Claude IA" : ""}</p>
</header>
<div class="kpi-strip" id="kpiStrip"></div>
<div class="tabs-nav">
  <button class="tab-btn on" data-tab="journey">\ud83d\uddfa\ufe0f Journey Map</button>
  <button class="tab-btn" data-tab="overview">\ud83d\udcca Overview</button>
  <button class="tab-btn" data-tab="opps">\ud83c\udfaf Oportunidades</button>
  ${activeComps.length ? '<button class="tab-btn" data-tab="comps">\u2694\ufe0f Competidores</button>' : ""}
  <button class="tab-btn" data-tab="keywords">\ud83d\udd11 Keywords</button>
  <button class="tab-btn" data-tab="revenue">\ud83d\udcb0 Revenue</button>
  ${gaps.length||activeComps.length ? '<button class="tab-btn" data-tab="gaps">\ud83c\udfaf Gaps</button>' : ""}
  ${recs.length||aiLoading ? '<button class="tab-btn" data-tab="recs">\ud83e\udd16 IA Recs</button>' : ""}
</div>

<div class="filters" style="position:sticky;top:38px;z-index:9">
  <div class="filter-group"><label>Arquetipo:</label><span id="archFilters"></span></div>
  <div class="filter-group"><label>Fase:</label><span id="phaseFilters"></span></div>
  <div class="filter-group" style="margin-left:auto"><input type="text" class="search-box" id="kwSearch" placeholder="Buscar keyword..."></div>
</div>

<!-- JOURNEY MAP TAB -->
<div class="tab-pnl on" id="tab-journey">
<div class="dashboard">
  <div class="card full"><div class="card-title"><span class="dot"></span>Arquetipos${aiLoading?" \u00b7 <span style='color:var(--gold)'>Analizando con IA...</span>":""}</div><div class="arch-cards" id="archCards"></div></div>
  <div class="card full"><div class="card-title"><span class="dot"></span>Heatmap: Clicks por Arquetipo \u00d7 Fase</div><div style="overflow-x:auto"><table class="heatmap" id="heatmap" style="min-width:600px"></table></div></div>
  <div class="card full"><div class="card-title"><span class="dot" style="background:var(--warn)"></span>Journey Map: Keywords + Insights</div><div style="overflow-x:auto"><div class="journey-map" id="journeyMap"></div></div></div>
  ${pains.length ? '<div class="card full"><div class="card-title"><span class="dot" style="background:var(--danger)"></span>Pain Points</div><div class="pain-grid" id="painGrid"></div></div>' : (aiLoading ? '<div class="card full"><div class="card-title"><span class="dot" style="background:var(--danger)"></span>Pain Points</div><div class="ai-loading"><span class="spinner"></span>Claude est\u00e1 analizando...</div></div>' : '')}
</div></div>

<!-- OVERVIEW TAB -->
<div class="tab-pnl" id="tab-overview">
<div class="dashboard">
  <div class="card"><div class="card-title"><span class="dot"></span>Impresiones vs Posici\u00f3n GSC</div><div class="chart-wrap"><canvas id="bubbleChart"></canvas></div></div>
  <div class="card"><div class="card-title"><span class="dot"></span>Clicks por fase \u00d7 arquetipo</div><div class="chart-wrap"><canvas id="phaseBar"></canvas></div></div>
  <div class="card"><div class="card-title"><span class="dot"></span>Distribuci\u00f3n por intenci\u00f3n</div><div class="chart-wrap"><canvas id="intentPie"></canvas></div></div>
  <div class="card"><div class="card-title"><span class="dot"></span>Radar: clicks medios \u00d7 fase</div><div class="chart-wrap"><canvas id="radarChart"></canvas></div></div>
  <div class="card full"><div class="card-title"><span class="dot"></span>Top P\u00e1ginas GA4</div><div id="pagesTable"></div></div>
</div></div>

<!-- OPORTUNIDADES TAB -->
<div class="tab-pnl" id="tab-opps">
<div class="dashboard">
  <div class="card full"><div class="card-title"><span class="dot" style="background:var(--gold)"></span>Scatter: KD vs Volumen</div><div class="chart-wrap" style="height:400px"><canvas id="scatterChart"></canvas></div></div>
</div></div>

<!-- COMPETITORS TAB -->
${activeComps.length ? `<div class="tab-pnl" id="tab-comps"><div class="dashboard">${sovHTML}</div></div>` : ""}

<!-- KEYWORDS TAB -->
<div class="tab-pnl" id="tab-keywords">
<div class="dashboard">
  <div class="card full"><div class="card-title"><span class="dot"></span>Tabla completa \u00b7 <span id="tableCount" style="color:var(--accent)"></span></div><div class="kw-table-wrap"><table class="kw-table" id="kwTable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
</div></div>

<!-- REVENUE TAB -->
<div class="tab-pnl" id="tab-revenue">
<div class="dashboard">
  <div class="card full"><div class="card-title"><span class="dot" style="background:var(--success)"></span>Revenue estimado por keyword</div><div id="revenueContent"></div></div>
</div></div>

<!-- GAPS TAB -->
${gaps.length||activeComps.length ? `<div class="tab-pnl" id="tab-gaps">
<div class="dashboard">
  ${gaps.length ? '<div class="card full"><div class="card-title"><span class="dot" style="background:var(--success)"></span>Content Gaps IA</div><div class="gap-list" id="gapList"></div></div>' : ""}
  ${activeComps.length ? '<div class="card full"><div class="card-title"><span class="dot" style="background:var(--gold)"></span>Gaps por competidor (DataForSEO)</div><div id="dfsGapList"></div></div>' : ""}
</div></div>` : ""}

<!-- RECS TAB -->
${recs.length||aiLoading ? `<div class="tab-pnl" id="tab-recs">
<div class="dashboard">
  <div class="card full"><div class="card-title"><span class="dot" style="background:var(--gold)"></span>\ud83e\udd16 Recomendaciones IA \u00b7 ${recs.length} insights</div><div id="recsContent">${aiLoading ? '<div class="ai-loading"><span class="spinner"></span>Generando recomendaciones...</div>' : ''}</div></div>
</div></div>` : ""}

<div style="color:var(--text3);font-size:.55rem;margin-top:16px;padding:10px 2rem;border-top:1px solid var(--border);text-align:center">taginc.es \u00b7 Customer Journey SEO Dashboard \u00b7 ${data.domain}</div>

<script>
var PH=["Descubrimiento","Investigaci\u00f3n","Evaluaci\u00f3n","Decisi\u00f3n","Compra","Post-venta"];
var PCS=${JSON.stringify(PCS)};
var KW=${kwsJSON};
var ARCHS=${archsJSON};
var PAINS=${painsJSON};
var GAPS=${gapsJSON};
var RECS=${recsJSON};
var INS=${insJSON};
var PAGES=${pagesJSON};
var COMPS=${compsJSON};
var COMP_GAPS=${compGapsJSON};
var COMP_SHARED=${compSharedJSON};
var COMP_COLORS=${JSON.stringify(COMP_COLORS)};
var AR=ARCHS.map(function(a){return a.id});
var AC={};ARCHS.forEach(function(a){AC[a.id]=a.color});
var IC={Informacional:"#3b6fa0",Comercial:"#d97706",Transaccional:"#0d6e5b",Navegacional:"#5a6d94"};
var aA=new Set(AR),aP="all",sT="",sC="clicks",sD=-1;
var expandedComp=null;

// TABS
document.querySelectorAll('.tab-btn').forEach(function(b){b.addEventListener('click',function(){
  document.querySelectorAll('.tab-btn').forEach(function(x){x.classList.remove('on')});
  document.querySelectorAll('.tab-pnl').forEach(function(x){x.classList.remove('on')});
  b.classList.add('on');var t=document.getElementById('tab-'+b.dataset.tab);if(t)t.classList.add('on');
})});

function fil(){return KW.filter(function(k){if(!k.archs||!k.archs.some(function(a){return aA.has(a)}))return aA.size===AR.length;if(aP!=="all"&&k.phase!==aP)return false;if(sT&&k.kw.toLowerCase().indexOf(sT.toLowerCase())===-1)return false;return true})}
function fmt(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e4)return(n/1e3).toFixed(0)+'K';return n.toLocaleString('es-ES')}

var bC,pB,iP,rC,sCh;
function initCharts(){
  Chart.defaults.color='#4a5e5c';Chart.defaults.font.family="'DM Sans',sans-serif";Chart.defaults.font.size=10;
  bC=new Chart(document.getElementById('bubbleChart'),{type:'bubble',data:{datasets:[]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{title:{display:true,text:'Posici\u00f3n'},grid:{color:'rgba(13,110,91,.06)'},min:0,max:50},y:{title:{display:true,text:'Impresiones'},grid:{color:'rgba(13,110,91,.06)'},min:0}},plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){var d=c.raw;return[d.label,'Imp: '+d.y+' | Pos: '+d.x]}}}}}});
  pB=new Chart(document.getElementById('phaseBar'),{type:'bar',data:{labels:PH,datasets:[]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',scales:{x:{grid:{color:'rgba(13,110,91,.06)'}},y:{grid:{display:false}}},plugins:{legend:{position:'bottom',labels:{boxWidth:10,padding:6,font:{size:9}}}}}});
  iP=new Chart(document.getElementById('intentPie'),{type:'doughnut',data:{labels:[],datasets:[{data:[],backgroundColor:[]}]},options:{responsive:true,maintainAspectRatio:false,cutout:'55%',plugins:{legend:{position:'right',labels:{boxWidth:10,padding:6,font:{size:9}}}}}});
  rC=new Chart(document.getElementById('radarChart'),{type:'radar',data:{labels:PH,datasets:[]},options:{responsive:true,maintainAspectRatio:false,scales:{r:{beginAtZero:true,grid:{color:'rgba(13,110,91,.08)'},angleLines:{color:'rgba(13,110,91,.08)'},ticks:{display:false},pointLabels:{font:{size:8}}}},plugins:{legend:{position:'bottom',labels:{boxWidth:10,padding:6,font:{size:9}}}}}});
}

function updateAll(){
  var d=fil();var tC=d.reduce(function(s,k){return s+k.clicks},0);var tI=d.reduce(function(s,k){return s+k.imp},0);
  var allGapKws=0;COMPS.forEach(function(c){allGapKws+=(COMP_GAPS[c.domain]||[]).length});
  document.getElementById('kpiStrip').innerHTML=[{v:d.length,l:'Keywords'},{v:tC.toLocaleString(),l:'Clicks'},{v:tI.toLocaleString(),l:'Impresiones'},{v:'\u20ac${data.revenue.total}',l:'Revenue 30d',c:'gold'},{v:COMPS.length,l:'Competidores'},{v:allGapKws,l:'Gap KWs'}].map(function(k){return '<div class="kpi"><div class="kpi-val '+(k.c||'')+'">'+k.v+'</div><div class="kpi-label">'+k.l+'</div></div>'}).join('');
  updAC();updBub(d);updPB(d);updIP(d);updRad(d);updHM(d);updPn();updJM(d);updGap();updRec();updTbl(d);updPages();updRev(d);updDfsGaps();
}

function updAC(){document.getElementById('archCards').innerHTML=ARCHS.filter(function(a){return aA.has(a.id)}).map(function(a){return '<div class="arch-card" style="border-top:3px solid '+a.color+'"><h3 style="color:'+a.color+'">'+a.icon+' '+a.name+'</h3><div class="desc">'+a.desc+'</div><div class="weight-row"><div class="weight-item"><div class="weight-val" style="color:'+a.color+'">'+a.pct+'%</div><div class="weight-lbl">% Tr\u00e1fico</div></div></div></div>'}).join('')}

function updBub(d){var top=d.slice(0,30);var mx=Math.max.apply(null,top.map(function(k){return k.imp}))||1;bC.data.datasets=[{data:top.map(function(k){return{x:k.pos,y:k.imp,r:Math.max(3,Math.sqrt(k.clicks/5)*3),label:k.kw}}),backgroundColor:'rgba(13,110,91,0.5)',borderColor:'#0d6e5b',borderWidth:1}];bC.options.scales.y.max=mx*1.1;bC.update()}

function updPB(d){pB.data.datasets=ARCHS.filter(function(a){return aA.has(a.id)}).map(function(a){return{label:a.name,data:PH.map(function(p){return d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).reduce(function(s,k){return s+k.clicks},0)}),backgroundColor:a.color+'cc',borderColor:a.color,borderWidth:1,borderRadius:3}});pB.update()}

function updIP(d){var g={};d.forEach(function(k){g[k.intent]=(g[k.intent]||0)+k.clicks});var l=Object.keys(g);iP.data.labels=l;iP.data.datasets[0].data=l.map(function(x){return g[x]});iP.data.datasets[0].backgroundColor=l.map(function(x){return IC[x]||'#666'});iP.update()}

function updRad(d){rC.data.datasets=ARCHS.filter(function(a){return aA.has(a.id)}).map(function(a){return{label:a.name,data:PH.map(function(p){var ks=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1});return ks.length?Math.round(ks.reduce(function(s,k){return s+k.clicks},0)/ks.length):0}),borderColor:a.color,backgroundColor:a.color+'22',pointBackgroundColor:a.color,borderWidth:2,pointRadius:3}});rC.update()}

function updHM(d){var h=document.getElementById('heatmap');var html='<tr><th class="row-h"></th>';PH.forEach(function(p,i){html+='<th style="color:'+PCS[i]+'">'+p+'</th>'});html+='</tr>';
var mx=1;ARCHS.forEach(function(a){PH.forEach(function(p){var v=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).reduce(function(s,k){return s+k.clicks},0);if(v>mx)mx=v})});
ARCHS.filter(function(a){return aA.has(a.id)}).forEach(function(a){html+='<tr><th class="row-h" style="color:'+a.color+'">'+a.name+'</th>';PH.forEach(function(p){var v=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).reduce(function(s,k){return s+k.clicks},0);var n=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).length;var op=Math.min(.9,v/mx+.1);html+='<td style="background:rgba(13,110,91,'+op+');color:'+(op>.5?'#fff':'var(--text)')+'">'+v+'<span class="sub">'+n+' kw</span></td>'});html+='</tr>'});h.innerHTML=html}

function updPn(){var el=document.getElementById('painGrid');if(!el)return;el.innerHTML=PAINS.filter(function(p){return p.archs.some(function(a){return aA.has(a)})}).map(function(p){return '<div class="pain-card"><div class="pt">'+p.title+' <span class="sev-dots">'+[1,2,3,4,5].map(function(i){return '<span class="sev-dot'+(i<=p.sev?' on':'')+'"><\/span>'}).join('')+'<\/span><\/div><div class="pd">'+p.desc+'<\/div><div class="pm">'+p.phases.map(function(ph){return '<span>'+ph+'<\/span>'}).join('')+p.archs.map(function(a){return '<span style="background:'+(AC[a]||'var(--accent)')+'22;color:'+(AC[a]||'var(--accent)')+'">'+a+'<\/span>'}).join('')+'<\/div><\/div>'}).join('')}

function updJM(d){var el=document.getElementById('journeyMap');var html='<div><\/div>';PH.forEach(function(p,i){html+='<div class="jm-phase" style="background:'+PCS[i]+'">'+p+'<\/div>'});
ARCHS.filter(function(a){return aA.has(a.id)}).forEach(function(a){html+='<div class="jm-arch-label" style="color:'+a.color+';background:'+a.color+'11">'+a.icon+' '+a.name+'<\/div>';
PH.forEach(function(p){var ks=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1});var ins_data=INS[a.id]&&INS[a.id][p]?INS[a.id][p]:null;var uid=a.id+'_'+p.replace(/[^a-zA-Z]/g,'');
html+='<div class="jm-cell"><ul class="kw-list">';
ks.slice(0,4).forEach(function(k){html+='<li>'+k.kw+' <span class="vol">'+k.clicks+'c #'+k.pos+'<\/span><\/li>'});
html+='<\/ul>';
if(ins_data){html+='<div class="ins-toggle" onclick="tog(&quot;ins_'+uid+'&quot;,this)">\u2630 Insight<\/div><div id="ins_'+uid+'" class="insight-body">';
html+='<div class="ib-s"><div class="ib-l">\ud83d\udcad Piensa<\/div>'+(ins_data.t||'')+'<\/div>';
html+='<div class="ib-s"><div class="ib-l">\u2764\ufe0f Siente<\/div>'+(ins_data.f||'')+'<\/div>';
if(ins_data.p&&ins_data.p.length)html+='<div class="ib-s"><div class="ib-l">\ud83d\udd34 Pains<\/div>'+ins_data.p.map(function(x){return '<div class="pain">\u2022 '+x+'<\/div>'}).join('')+'<\/div>';
if(ins_data.g&&ins_data.g.length)html+='<div class="ib-s"><div class="ib-l">\ud83d\udfe2 Gains<\/div>'+ins_data.g.map(function(x){return '<div class="gain">\u2022 '+x+'<\/div>'}).join('')+'<\/div>';
html+='<\/div>'}
html+='<\/div>'})});el.innerHTML=html}

function updGap(){var el=document.getElementById('gapList');if(!el)return;el.innerHTML=GAPS.map(function(g){return '<div class="gap-item" style="border-left-color:'+(AC[g.arch]||'var(--accent)')+'"><div><div class="gt">'+g.title+'<\/div><div class="gk">'+g.kws+'<\/div><\/div><div class="gpri"><span class="gpb '+g.prio+'">'+g.prio+'<\/span><\/div><\/div>'}).join('')}

function updRec(){var el=document.getElementById('recsContent');if(!el)return;var pc={ALTA:'var(--danger)',MEDIA:'var(--warn)',BAJA:'var(--success)'};
el.innerHTML=RECS.map(function(r){return '<div class="rec-card" style="border-left:3px solid '+(pc[r.priority]||'var(--accent)')+'"><div class="rc-head"><span class="rc-title">'+r.title+'<\/span><span class="rc-tag" style="background:rgba(185,28,28,.1);color:var(--danger)">'+r.priority+'<\/span><span class="rc-tag" style="background:rgba(13,110,91,.08);color:var(--text2)">'+(r.type||'')+'<\/span><\/div><div class="rc-desc">'+r.description+'<\/div><div class="rc-meta"><span>\ud83d\udccd '+(r.phase||'')+'<\/span><span>\ud83d\udcb0 '+(r.impact||'')+'<\/span><span>\u23f1 '+(r.effort||'')+'<\/span><\/div><\/div>'}).join('')}

function updTbl(d){var hdr=document.querySelector('#kwTable thead tr');var cols=[{k:'kw',l:'Keyword'},{k:'phase',l:'Fase'},{k:'intent',l:'Intent'},{k:'clicks',l:'Clicks'},{k:'imp',l:'Imp'},{k:'ctr',l:'CTR%'},{k:'pos',l:'Pos'}];
hdr.innerHTML=cols.map(function(c){return '<th data-col="'+c.k+'"'+(c.k!=='kw'?' class="right"':'')+'>'+c.l+(sC===c.k?(sD>0?' \u25b2':' \u25bc'):'')+'<\/th>'}).join('');
var sorted=d.slice().sort(function(a,b){var va=a[sC],vb=b[sC];if(typeof va==='string')return va.localeCompare(vb)*sD;return(va-vb)*sD});
document.getElementById('tableCount').textContent=sorted.length+' keywords';
var tbody=document.querySelector('#kwTable tbody');tbody.innerHTML=sorted.map(function(k){var pc=k.pos<=5?'color:var(--success)':k.pos<=10?'color:var(--warn)':'color:var(--danger)';var ic={Informacional:'background:rgba(59,111,160,.1);color:#3b6fa0',Comercial:'background:rgba(217,119,6,.1);color:#d97706',Transaccional:'background:rgba(13,110,91,.1);color:#0d6e5b',Navegacional:'background:rgba(90,109,148,.1);color:#5a6d94'}[k.intent]||'';
return '<tr><td>'+k.kw+'<\/td><td><span class="pill" style="background:rgba(13,110,91,.06)">'+k.phase+'<\/span><\/td><td><span class="pill" style="'+ic+'">'+(k.intent||'')+'<\/span><\/td><td class="right mono" style="font-weight:700">'+k.clicks+'<\/td><td class="right mono">'+k.imp.toLocaleString()+'<\/td><td class="right mono">'+(k.ctr||0)+'%<\/td><td class="right mono" style="font-weight:700;'+pc+'">'+(k.pos||0)+'<\/td><\/tr>'}).join('')}

function updPages(){var el=document.getElementById('pagesTable');if(!el)return;
el.innerHTML='<table style="width:100%;border-collapse:collapse;font-size:.72rem"><thead><tr><th style="text-align:left;padding:5px;font-size:.58rem;text-transform:uppercase;color:var(--text2);border-bottom:1px solid var(--border)">P\u00e1gina<\/th><th style="text-align:right;padding:5px;font-size:.58rem;text-transform:uppercase;color:var(--text2);border-bottom:1px solid var(--border)">Sesiones<\/th><th style="text-align:right;padding:5px;font-size:.58rem;text-transform:uppercase;color:var(--text2);border-bottom:1px solid var(--border)">Revenue<\/th><\/tr><\/thead><tbody>'+PAGES.slice(0,12).map(function(p){return '<tr><td style="padding:4px 5px;border-bottom:1px solid rgba(0,0,0,.04);font-size:.68rem">'+p.page+'<\/td><td style="text-align:right;padding:4px 5px;border-bottom:1px solid rgba(0,0,0,.04);font-family:Space Mono,monospace;font-size:.68rem">'+p.sessions.toLocaleString()+'<\/td><td style="text-align:right;padding:4px 5px;border-bottom:1px solid rgba(0,0,0,.04);font-family:Space Mono,monospace;font-size:.68rem">\u20ac'+p.revenue.toLocaleString()+'<\/td><\/tr>'}).join('')+'<\/tbody><\/table>'}

function updRev(d){var el=document.getElementById('revenueContent');if(!el)return;
var cr=0.0185,tk=224.85,ctr3=0.17;
var rows=d.filter(function(k){return k.imp>100}).sort(function(a,b){return b.imp-a.imp}).slice(0,20).map(function(k){
  var cur=k.pos>0&&k.pos<=10?Math.round(k.imp*(k.pos<=3?ctr3:0.025)*cr*tk):0;
  var pot=Math.round(k.imp*ctr3*cr*tk);
  return '<tr><td style="padding:4px 6px;border-bottom:1px solid rgba(0,0,0,.04)">'+k.kw+'<\/td><td style="text-align:right;padding:4px 6px;font-family:Space Mono,monospace;border-bottom:1px solid rgba(0,0,0,.04)">'+k.imp.toLocaleString()+'<\/td><td style="text-align:right;padding:4px 6px;font-family:Space Mono,monospace;border-bottom:1px solid rgba(0,0,0,.04)">\u20ac'+cur.toLocaleString()+'<\/td><td style="text-align:right;padding:4px 6px;font-family:Space Mono,monospace;color:var(--success);border-bottom:1px solid rgba(0,0,0,.04)">\u20ac'+pot.toLocaleString()+'<\/td><td style="text-align:right;padding:4px 6px;font-family:Space Mono,monospace;color:var(--success);border-bottom:1px solid rgba(0,0,0,.04)">+\u20ac'+(pot-cur).toLocaleString()+'<\/td><\/tr>'});
el.innerHTML='<p style="font-size:.66rem;color:var(--text3);margin-bottom:6px">Vol \u00d7 CTR \u00d7 1,85% conv \u00d7 \u20ac224,85 ticket<\/p><table style="width:100%;border-collapse:collapse;font-size:.7rem"><thead><tr><th style="text-align:left;padding:4px 6px;font-size:.58rem;text-transform:uppercase;color:var(--text2);border-bottom:1px solid var(--border)">Keyword<\/th><th style="text-align:right;padding:4px 6px;font-size:.58rem;text-transform:uppercase;color:var(--text2);border-bottom:1px solid var(--border)">Imp.<\/th><th style="text-align:right;padding:4px 6px;font-size:.58rem;text-transform:uppercase;color:var(--text2);border-bottom:1px solid var(--border)">\u20ac/mes actual<\/th><th style="text-align:right;padding:4px 6px;font-size:.58rem;text-transform:uppercase;color:var(--text2);border-bottom:1px solid var(--border)">\u20ac/mes Top 3<\/th><th style="text-align:right;padding:4px 6px;font-size:.58rem;text-transform:uppercase;color:var(--text2);border-bottom:1px solid var(--border)">\u0394<\/th><\/tr><\/thead><tbody>'+rows.join('')+'<\/tbody><\/table>'}

function updDfsGaps(){var el=document.getElementById('dfsGapList');if(!el)return;
var html='';
COMPS.forEach(function(c,ci){
  var g=COMP_GAPS[c.domain]||[];if(!g.length)return;
  var col=COMP_COLORS[ci%COMP_COLORS.length];
  html+='<div style="margin-bottom:10px"><div style="font-size:.72rem;font-weight:600;color:'+col+';margin-bottom:4px;display:flex;align-items:center;gap:4px"><span style="width:7px;height:7px;border-radius:50%;background:'+col+'"><\/span>'+c.domain+' \u2014 '+g.length+' gaps ('+g.reduce(function(s,x){return s+x.vol},0).toLocaleString()+'/mes)<\/div>';
  html+='<div class="gap-mini">';
  g.sort(function(a,b){return b.vol-a.vol}).slice(0,10).forEach(function(x){
    html+='<div class="gap-mini-row"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+x.kw+' <span style="font-size:.48rem;color:var(--text3)">pos.'+x.posComp+'<\/span><\/span><span style="font-family:Space Mono,monospace;color:var(--accent);font-weight:600;margin-left:6px">'+x.vol.toLocaleString()+'<\/span><\/div>'});
  html+='<\/div><\/div>'});
el.innerHTML=html||'<div style="text-align:center;color:var(--text3);padding:12px">Sin datos de gaps<\/div>'}

function toggleDetail(domain){
  var area=document.getElementById('compDetailArea');if(!area)return;
  if(expandedComp===domain){expandedComp=null;area.innerHTML='';return}
  expandedComp=domain;
  var ci=COMPS.findIndex(function(c){return c.domain===domain});
  var col=COMP_COLORS[ci%COMP_COLORS.length];
  var shared=COMP_SHARED[domain]||[];
  var gapKws=COMP_GAPS[domain]||[];
  var dn=domain.split('.')[0];
  var wins=shared.filter(function(s){return s.posQ<=s.posC}).length;
  var losses=shared.filter(function(s){return s.posQ>s.posC}).length;
  var bvol=shared.reduce(function(s,x){return s+x.vol},0);
  var gvol=gapKws.reduce(function(s,x){return s+x.vol},0);

  var h='<div style="border:1px solid '+col+';border-left:3px solid '+col+';border-radius:8px;padding:12px;margin-top:8px">';
  h+='<div style="font-size:.76rem;font-weight:700;margin-bottom:8px">'+domain+' vs tu dominio<\/div>';

  // Win/Loss
  if(shared.length){
    h+='<div style="font-size:.58rem;font-weight:700;text-transform:uppercase;color:var(--text2);margin-bottom:4px">Keywords compartidas: Win / Loss<\/div>';
    h+='<div class="wl-grid"><div class="wl-box"><div class="wl-v" style="color:var(--success)">'+wins+'<\/div><div class="wl-l">Ganas t\u00fa<\/div><\/div><div class="wl-box"><div class="wl-v" style="color:var(--danger)">'+losses+'<\/div><div class="wl-l">Gana '+dn+'<\/div><\/div><div class="wl-box"><div class="wl-v">'+fmt(bvol)+'<\/div><div class="wl-l">Vol. disputado<\/div><\/div><\/div>';
    h+='<table style="width:100%;border-collapse:collapse;font-size:.6rem;margin-bottom:8px"><tr><th style="text-align:left;padding:3px;color:var(--text2);font-size:.52rem;text-transform:uppercase;border-bottom:1px solid var(--border)">Keyword<\/th><th style="text-align:right;padding:3px;color:var(--text2);font-size:.52rem;text-transform:uppercase;border-bottom:1px solid var(--border)">Vol.<\/th><th style="text-align:right;padding:3px;color:var(--text2);font-size:.52rem;text-transform:uppercase;border-bottom:1px solid var(--border)">Pos. T\u00fa<\/th><th style="text-align:right;padding:3px;color:var(--text2);font-size:.52rem;text-transform:uppercase;border-bottom:1px solid var(--border)">Pos. '+dn+'<\/th><th style="padding:3px"><\/th><\/tr>';
    shared.sort(function(a,b){return b.vol-a.vol}).slice(0,10).forEach(function(s){
      var w=s.posQ<=s.posC;
      h+='<tr><td style="padding:2px 3px;border-bottom:1px solid rgba(0,0,0,.04);font-family:inherit">'+s.kw+'<\/td><td style="text-align:right;padding:2px 3px;font-family:Space Mono,monospace;border-bottom:1px solid rgba(0,0,0,.04)">'+s.vol.toLocaleString()+'<\/td><td style="text-align:right;padding:2px 3px;font-family:Space Mono,monospace;color:'+(w?'var(--success)':'var(--danger)')+';border-bottom:1px solid rgba(0,0,0,.04)">'+s.posQ+'<\/td><td style="text-align:right;padding:2px 3px;font-family:Space Mono,monospace;color:'+(w?'var(--danger)':'var(--success)')+';border-bottom:1px solid rgba(0,0,0,.04)">'+s.posC+'<\/td><td style="padding:2px 3px;border-bottom:1px solid rgba(0,0,0,.04)">'+(w?'<span style="color:var(--success)">\u2713<\/span>':'<span style="color:var(--danger)">\u2717<\/span>')+'<\/td><\/tr>'});
    h+='<\/table>'
  }

  // Gap
  if(gapKws.length){
    h+='<div style="font-size:.58rem;font-weight:700;text-transform:uppercase;color:var(--text2);margin-bottom:4px;margin-top:6px">Gap exclusivo ('+fmt(gvol)+'/mes) \u2014 '+dn+' rankea, t\u00fa no<\/div>';
    h+='<div class="gap-mini">';
    gapKws.sort(function(a,b){return b.vol-a.vol}).slice(0,10).forEach(function(g){
      h+='<div class="gap-mini-row"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+g.kw+' <span style="font-size:.48rem;color:var(--text3)">pos.'+g.posComp+'<\/span><\/span><span style="font-family:Space Mono,monospace;color:var(--accent);font-weight:600;margin-left:6px">'+g.vol.toLocaleString()+'<\/span><\/div>'});
    h+='<\/div>'
  }
  h+='<\/div>';
  area.innerHTML=h;
}

function tog(id,btn){var el=document.getElementById(id);if(!el)return;var o=el.classList.toggle('open');btn.innerHTML=o?'\u2630 Ocultar':'\u2630 Insight'}

function buildFilters(){
  var af=document.getElementById('archFilters');af.innerHTML=ARCHS.map(function(a){return '<button class="fbtn active" data-arch="'+a.id+'" style="border-color:'+a.color+'">'+a.icon+' '+a.name+'<\/button>'}).join('');
  af.querySelectorAll('.fbtn').forEach(function(b){b.addEventListener('click',function(){b.classList.toggle('active');var v=b.dataset.arch;if(aA.has(v))aA.delete(v);else aA.add(v);updateAll()})});
  var pf=document.getElementById('phaseFilters');pf.innerHTML=['all'].concat(PH).map(function(p){return '<button class="fbtn'+(p==='all'?' active':'')+'" data-phase="'+p+'">'+(p==='all'?'Todas':p.substring(0,6))+'<\/button>'}).join('');
  pf.querySelectorAll('.fbtn').forEach(function(b){b.addEventListener('click',function(){pf.querySelectorAll('.fbtn').forEach(function(x){x.classList.remove('active')});b.classList.add('active');aP=b.dataset.phase;updateAll()})});
}

document.addEventListener('DOMContentLoaded',function(){buildFilters();initCharts();updateAll();
document.getElementById('kwSearch').addEventListener('input',function(e){sT=e.target.value;updateAll()});
document.querySelector('#kwTable thead').addEventListener('click',function(e){var th=e.target.closest('th');if(!th)return;var c=th.dataset.col;if(sC===c)sD*=-1;else{sC=c;sD=['kw','intent','phase'].indexOf(c)!==-1?1:-1}updateAll()})});
<\/script></body></html>`;
}
