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
  const [step, setStep] = useState<"select"|"competitors"|"dashboard">("select");
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [domainOverview, setDomainOverview] = useState<any>(null);
  const [compLoading, setCompLoading] = useState(false);
  const [compInput, setCompInput] = useState("");

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

  const discoverCompetitors = useCallback(async () => {
    if (!selectedGsc) return;
    setCompLoading(true);
    const domain = selectedGsc.replace("sc-domain:", "").replace(/https?:\/\//, "").replace(/\/$/, "").replace(/^www\./, "");
    try {
      const res = await fetch("/api/dataforseo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "discover", domain }) });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDomainOverview(data.domain);
      setCompetitors(data.competitors || []);
      setStep("competitors");
    } catch (err: any) { console.error("Discover error:", err); setStep("competitors"); }
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

  const fetchInsights = useCallback(async (fullData: any) => {
    setAiLoading(true);
    try {
      // Build FULL keyword universe: GSC + competitor gaps + competitor shared
      const allKws: any[] = [...(fullData.keywords || [])];
      const compGaps = fullData.compGaps || {};
      const compShared = fullData.compShared || {};
      // Add gap keywords (competitor ranks, quimipool doesn't)
      Object.entries(compGaps).forEach(([dom, gaps]: [string, any]) => {
        (gaps || []).forEach((g: any) => {
          if (!allKws.find((k: any) => k.kw === g.kw)) {
            allKws.push({ kw: g.kw, clicks: 0, imp: g.vol || 0, ctr: 0, pos: 0, source: "gap:" + dom, kd: g.kd || 0 });
          }
        });
      });
      // Add shared keywords with competitor positions
      Object.entries(compShared).forEach(([dom, shared]: [string, any]) => {
        (shared || []).forEach((s: any) => {
          const existing = allKws.find((k: any) => k.kw === s.kw);
          if (existing) { existing.posComp = s.posC; existing.compDomain = dom; }
          else { allKws.push({ kw: s.kw, clicks: 0, imp: s.vol || 0, ctr: 0, pos: s.posQ || 0, source: "shared:" + dom, posComp: s.posC }); }
        });
      });

      // Classify all keywords
      const classified = allKws.map((k: any) => ({
        ...k,
        phase: classifyPhase(k.kw, k.pos),
        intent: classifyIntent(k.kw),
        archs: classifyArchs(k.kw),
        cluster: classifyCluster(k.kw),
      }));

      // Build cluster summary (compact text for Claude)
      const clusterMap: Record<string, any[]> = {};
      classified.forEach((k: any) => { if (!clusterMap[k.cluster]) clusterMap[k.cluster] = []; clusterMap[k.cluster].push(k); });

      const clusterLines = Object.entries(clusterMap)
        .map(([name, items]) => {
          const imp = items.reduce((s: number, k: any) => s + k.imp, 0);
          const clicks = items.reduce((s: number, k: any) => s + k.clicks, 0);
          const avgPos = items.filter((k: any) => k.pos > 0).length ? +(items.filter((k: any) => k.pos > 0).reduce((s: number, k: any) => s + k.pos, 0) / items.filter((k: any) => k.pos > 0).length).toFixed(1) : 0;
          const gscCount = items.filter((k: any) => !k.source).length;
          const gapCount = items.filter((k: any) => k.source?.startsWith("gap:")).length;
          const top3 = [...items].sort((a, b) => b.imp - a.imp).slice(0, 3).map((k: any) => '"' + k.kw + '" ' + k.imp + 'imp' + (k.pos > 0 ? ' pos.' + k.pos.toFixed?.(1) : ' [gap]'));
          const weak = items.filter((k: any) => k.imp > 100 && k.pos > 15).slice(0, 2).map((k: any) => '"' + k.kw + '" pos.' + k.pos.toFixed?.(1) + ' ' + k.imp + 'imp');
          return { name, count: items.length, imp, clicks, avgPos, gscCount, gapCount, top3, weak };
        })
        .sort((a, b) => b.imp - a.imp)
        .slice(0, 12);

      let clusterSummary = "=== CLUSTERS SEMANTICOS (GSC + gaps competidores) ===\n";
      clusterLines.forEach(cl => {
        clusterSummary += cl.name + ": " + cl.count + "kw (" + cl.gscCount + " GSC + " + cl.gapCount + " gaps), " + cl.imp + "imp, " + cl.clicks + "cl, pos." + cl.avgPos + "\n";
        clusterSummary += "  Top: " + cl.top3.join(", ") + "\n";
        if (cl.weak.length) clusterSummary += "  Oportunidad: " + cl.weak.join(", ") + "\n";
      });

      // Phase summary
      const phases: Record<string, { count: number; clicks: number; imp: number }> = {};
      classified.forEach((k: any) => {
        if (!phases[k.phase]) phases[k.phase] = { count: 0, clicks: 0, imp: 0 };
        phases[k.phase].count++; phases[k.phase].clicks += k.clicks; phases[k.phase].imp += k.imp;
      });
      let phaseSummary = "=== FASES ===\n";
      Object.entries(phases).forEach(([p, d]) => { phaseSummary += p + ": " + d.count + "kw, " + d.clicks + "cl, " + d.imp + "imp\n"; });

      // Patterns
      const gapTotal = Object.values(compGaps).reduce((s: number, g: any) => s + (g?.length || 0), 0);
      const sharedTotal = Object.values(compShared).reduce((s: number, g: any) => s + (g?.length || 0), 0);
      let patterns = "=== PATRONES ===\n";
      patterns += "- " + fullData.keywords.length + " keywords propias (GSC) + " + gapTotal + " gaps de competidores + " + sharedTotal + " compartidas\n";
      patterns += "- Competidores activos: " + (fullData.competitors || []).map((c: any) => c.domain + " (ETV:" + c.etv + ")").join(", ") + "\n";
      const intlCount = classified.filter((k: any) => /pièces|ersatz|onderdelen|duikplank|pompe|recinzione|copertura|couverture|boia|escada/.test(k.kw)).length;
      if (intlCount) patterns += "- " + intlCount + " busquedas internacionales (FR, DE, NL, PT, IT)\n";
      const refCount = classified.filter((k: any) => /^\d{5,}|\d{7}/.test(k.kw)).length;
      if (refCount) patterns += "- " + refCount + " busquedas por referencia/SKU exacta\n";
      const probCount = classified.filter((k: any) => /como |cómo |pierde agua|no arranca|eliminar algas/.test(k.kw)).length;
      if (probCount) patterns += "- " + probCount + " busquedas de problemas/soluciones\n";

      // Call insights with COMPACT body (just text summaries)
      const res = await fetch("/api/insights", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: fullData.domain,
          revenue: fullData.revenue,
          clusterSummary,
          phaseSummary,
          patterns,
        }),
      });
      const json = await res.json();

      // Build insights locally from classified keywords
      const archIds = (json.archetypes || []).map((a: any) => a.id);
      const localInsights = buildLocalInsights(classified, archIds.length ? archIds : ["A1","A2","A3","A4","A5","A6"]);

      setJourney({
        keywords_classified: classified,
        archetypes: padTo6(json.archetypes),
        pain_points: json.pain_points || [],
        insights: localInsights,
        content_gaps: json.content_gaps || [],
        recommendations: json.recommendations || [],
      });
    } catch (err) { console.error("Insights error:", err); }
    setAiLoading(false);
  }, []);

  const fetchData = useCallback(async () => {
    if (!selectedGsc || !selectedGa4) return;
    setDataLoading(true);
    setJourney(null);
    setStep("dashboard");
    const domain = selectedGsc.replace("sc-domain:", "").replace(/https?:\/\//, "").replace(/\/$/, "").replace(/^www\./, "");
    const activeComps = competitors.filter(c => c.active);
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

      // Enrich top keywords with KD from DataForSEO
      const topKwNames = keywords.slice(0, 200).map((k: any) => k.kw);
      let kwEnrichMap: Record<string, any> = {};
      if (topKwNames.length > 0) {
        try {
          const enRes = await fetch("/api/dataforseo", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "keywords", keywords: topKwNames }) }).then(r => r.json());
          (enRes.keywords || []).forEach((ek: any) => { kwEnrichMap[ek.kw.toLowerCase()] = ek; });
        } catch (e) { console.warn("KW enrichment failed:", e); }
      }
      keywords.forEach((k: any) => {
        const en = kwEnrichMap[k.kw.toLowerCase()];
        if (en) { k.kd = en.kd || 0; k.vol = en.vol || k.imp; k.cpcDfs = en.cpc || 0; k.intentDfs = en.intent || ""; }
      });

      // Fetch gaps and shared for active competitors
      const compGaps: Record<string, any[]> = {};
      const compShared: Record<string, any[]> = {};
      const gapPromises = activeComps.map(c =>
        fetch("/api/dataforseo", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "gap", domain, competitorDomain: c.domain }) }).then(r => r.json()).catch(() => ({ gaps: [] }))
      );
      const sharedPromises = activeComps.map(c =>
        fetch("/api/dataforseo", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "shared", domain, competitorDomain: c.domain }) }).then(r => r.json()).catch(() => ({ shared: [] }))
      );
      const [gapResults, sharedResults] = await Promise.all([Promise.all(gapPromises), Promise.all(sharedPromises)]);
      activeComps.forEach((c, i) => { compGaps[c.domain] = gapResults[i]?.gaps || []; compShared[c.domain] = sharedResults[i]?.shared || []; });

      const totalRevenue = ga4Pages.reduce((s: number, p: any) => s + p.revenue, 0);
      const totalPurchases = ga4Pages.reduce((s: number, p: any) => s + p.purchases, 0);
      const totalSessions = ga4Pages.reduce((s: number, p: any) => s + p.sessions, 0);

      const data = {
        domain, keywords, ga4Pages,
        revenue: { total: totalRevenue.toFixed(0), transactions: totalPurchases, sessions: totalSessions },
        competitors: activeComps, compGaps, compShared, domainOverview,
      };
      setDashData(data);
      setDataLoading(false);
    } catch (err) { console.error(err); setDataLoading(false); }
  }, [selectedGsc, selectedGa4, competitors, domainOverview]);

  // Render iframe when data changes
  useEffect(() => {
    if (!dashData || !iframeRef.current) return;
    const html = generateDashboardHTML(dashData, journey, aiEnabled, aiLoading);
    iframeRef.current.srcdoc = html;
  }, [dashData, journey, aiEnabled, aiLoading]);

  // FIX: Trigger insights independently when dashData is ready
  useEffect(() => {
    if (dashData && aiEnabled && !journey && !aiLoading) {
      fetchInsights(dashData);
    }
  }, [dashData, aiEnabled, journey, aiLoading, fetchInsights]);

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
        {step === "select" && <button onClick={discoverCompetitors} disabled={compLoading} style={{ padding:"0.4rem 1.2rem",borderRadius:8,border:"none",background:"#52525b",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:"0.8rem",fontWeight:600,cursor:compLoading?"wait":"pointer",opacity:compLoading?0.6:1 }}>{compLoading ? "Descubriendo..." : "▶ Configurar competidores"}</button>}
        {step === "competitors" && <button onClick={fetchData} disabled={dataLoading} style={{ padding:"0.4rem 1.2rem",borderRadius:8,border:"none",background:"#52525b",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:"0.8rem",fontWeight:600,cursor:dataLoading?"wait":"pointer",opacity:dataLoading?0.6:1 }}>{dataLoading ? "Generando..." : `▶ Generar Dashboard (${activeCount} comp.)`}</button>}
        {step === "dashboard" && <button onClick={() => setStep("competitors")} style={{ padding:"0.4rem 1.2rem",borderRadius:8,border:"1px solid #cdd9d4",background:"transparent",color:"#4a5e5c",fontFamily:"'DM Sans',sans-serif",fontSize:"0.8rem",fontWeight:600,cursor:"pointer" }}>⚙️ Competidores</button>}
        <span className={"ai-badge " + (aiEnabled ? "on" : "off")}>{aiEnabled ? "🤖 IA ON" : "🤖 IA OFF"}</span>
        <button className="logout-btn" onClick={() => signOut({ callbackUrl: "/" })}>Cerrar sesión</button>
      </div>
      {step === "competitors" && (
        <div style={{ padding:"1.5rem 2rem",maxWidth:900,margin:"0 auto",width:"100%" }}>
          {domainOverview && <div style={{ background:"rgba(9,9,11,.06)",border:"1px solid rgba(9,9,11,.15)",borderRadius:12,padding:"1rem 1.2rem",marginBottom:"1rem" }}>
            <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:6 }}><span style={{ width:8,height:8,borderRadius:"50%",background:"#52525b" }}></span><strong style={{ fontSize:".85rem" }}>Tu dominio</strong></div>
            <div style={{ display:"flex",gap:24,fontSize:".8rem",color:"#4a5e5c" }}><span>ETV: <strong>{(domainOverview.etv||0).toLocaleString()}</strong></span><span>KWs: <strong>{(domainOverview.count||0).toLocaleString()}</strong></span><span>Top 10: <strong>{domainOverview.top10||0}</strong></span></div>
          </div>}
          <div style={{ background:"#fff",border:"1px solid #cdd9d4",borderRadius:12,padding:"1.2rem",marginBottom:"1rem" }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}><strong style={{ fontSize:".8rem",color:"#4a5e5c",textTransform:"uppercase",letterSpacing:".06em" }}>Competidores</strong><span style={{ fontSize:".7rem",color:"#7a9190" }}>{manualCount}/5 manuales · {activeCount} activos</span></div>
            <div style={{ display:"flex",gap:8,marginBottom:12 }}><input type="text" value={compInput} onChange={e => setCompInput(e.target.value)} onKeyDown={e => e.key==="Enter"&&addComp()} placeholder="Añadir competidor manual..." disabled={manualCount>=5} style={{ flex:1,padding:"8px 12px",borderRadius:8,border:"1px solid #cdd9d4",background:"#f5f8f7",fontSize:".82rem",fontFamily:"'DM Sans',sans-serif",outline:"none" }} /><button onClick={addComp} disabled={manualCount>=5} style={{ padding:"8px 16px",borderRadius:8,border:"none",background:"#52525b",color:"#fff",fontSize:".82rem",fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif" }}>+ Añadir</button></div>
            <div style={{ display:"flex",flexDirection:"column",gap:6,maxHeight:360,overflowY:"auto" }}>
              {competitors.map(c => (
                <div key={c.domain} onClick={() => toggleComp(c.domain)} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",borderRadius:8,border:`1px solid ${c.active?"rgba(9,9,11,.3)":"#cdd9d4"}`,background:c.active?"rgba(9,9,11,.04)":"#f5f8f7",cursor:"pointer",opacity:c.active?1:0.5,transition:"all .15s" }}>
                  <div>
                    <div style={{ display:"flex",alignItems:"center",gap:6 }}><span style={{ fontSize:".82rem",fontWeight:600 }}>{c.domain}</span><span style={{ fontSize:".55rem",padding:"1px 5px",borderRadius:3,fontWeight:700,background:c.source==="manual"?"rgba(9,9,11,.12)":"rgba(0,0,0,.06)",color:c.source==="manual"?"#52525b":"#7a9190" }}>{c.source==="manual"?"MANUAL":"AUTO"}</span>{c.type!=="Unknown"&&<span style={{ fontSize:".55rem",color:"#7a9190" }}>{c.type}</span>}</div>
                    {c.etv>0&&<div style={{ display:"flex",gap:16,fontSize:".7rem",color:"#7a9190",marginTop:3 }}><span>ETV: {c.etv.toLocaleString()}</span><span>KWs: {c.count.toLocaleString()}</span><span>Shared: {c.shared}</span></div>}
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                    <div style={{ width:20,height:20,borderRadius:4,border:`2px solid ${c.active?"#52525b":"#ccc"}`,background:c.active?"#52525b":"transparent",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:".65rem" }}>{c.active&&"✓"}</div>
                    {c.source==="manual"&&<button onClick={e=>{e.stopPropagation();removeComp(c.domain)}} style={{ width:20,height:20,borderRadius:4,border:"1px solid rgba(185,28,28,.2)",background:"transparent",color:"#b91c1c",display:"flex",alignItems:"center",justifyContent:"center",fontSize:".65rem",cursor:"pointer" }}>✕</button>}
                  </div>
                </div>
              ))}
              {competitors.length===0&&<div style={{ textAlign:"center",padding:20,color:"#7a9190",fontSize:".82rem" }}>{compLoading?"Descubriendo competidores...":"No se encontraron. Añade uno manualmente."}</div>}
            </div>
          </div>
        </div>
      )}
      {step==="dashboard"&&!dashData&&<div className="loading-wrap" style={{ flex:1 }}><div style={{ textAlign:"center",color:"#4a5e5c" }}><div className="spinner" style={{ margin:"0 auto 1rem" }}></div><div style={{ fontSize:".9rem",fontWeight:600 }}>Generando Customer Journey Dashboard...</div><div style={{ fontSize:".75rem",color:"#7a9190",marginTop:4 }}>GSC + GA4 + DataForSEO + Claude IA</div></div></div>}
      {step==="dashboard"&&dashData&&<iframe ref={iframeRef} style={{ flex:1,border:"none",width:"100%",minHeight:"calc(100vh - 60px)" }} title="Dashboard" />}
      {step==="select"&&<div className="loading-wrap" style={{ flex:1 }}><div style={{ textAlign:"center",color:"#4a5e5c" }}><div style={{ fontSize:"3rem",marginBottom:"1rem" }}>📊</div><div style={{ fontSize:"1rem",fontWeight:600,marginBottom:"0.5rem" }}>Selecciona tus propiedades y pulsa &quot;Configurar competidores&quot;</div><div style={{ fontSize:"0.8rem" }}>El sistema descubrirá automáticamente tus competidores con DataForSEO</div></div></div>}
    </div>
  );
}


// ═══ CLIENT-SIDE CLASSIFICATION ═══
function classifyPhase(kw: string, pos: number): string {
  const k = (kw || "").toLowerCase();
  if (/recambio|repuesto|manual|pieza|part|replacement|invern/.test(k)) return "Post-venta";
  if (/quimipool|quimpool|quimipol/.test(k)) return "Compra";
  if (/precio|cuanto|cuánto|barato|oferta|comparar|opiniones/.test(k)) return "Evaluación";
  if (/como |cómo |que es|qué es|diferencia|mejor |cual |cuál |tutorial|guia|guía/.test(k)) return "Investigación";
  if (/limpiafondos|clorador|depuradora|filtro|robot|cubierta|bomba|valla|escalera|gresite/.test(k)) return "Evaluación";
  return "Descubrimiento";
}
function classifyIntent(kw: string): string {
  const k = (kw || "").toLowerCase();
  if (/quimipool|astralpool|espa |seko |zodiac |kripsol|poolex/.test(k)) return "Navegacional";
  if (/comprar|precio|barato|oferta|tienda/.test(k)) return "Transaccional";
  if (/mejor|comparar|comparativa|vs |opiniones|review|alternativa/.test(k)) return "Comercial";
  if (/como |cómo |que es|qué es|tutorial|guia|guía|diferencia/.test(k)) return "Informacional";
  return "Comercial";
}
function classifyArchs(kw: string): string[] {
  const k = (kw || "").toLowerCase();
  if (/quimipool/.test(k)) return ["A1","A2","A3","A4","A5","A6"];
  const a: string[] = [];
  if (/seko|tekna|dosificadora|fotometro|fotómetro|orp|kontrol|etatron|poollab|lovibond|hanna|turbidimetro|cuadro.*electr/.test(k)) a.push("A4");
  if (/robot|dolphin|wybot|beatbot|zodiac|sin cable|clorador salino|cubierta.*auto|liberty|sora|aquasense/.test(k)) a.push("A3");
  if (/recambio|repuesto|part|manual|despiece|diagram|ersatz|pièces|spare|replacement|\d{7}/.test(k)) a.push("A2");
  if (/depuradora|mantenimiento|cloro|filtro piscina|como |cómo |gresite|valla|escalera|productos.*pisc/.test(k)) a.push("A1");
  if (/desmontable|gre |intex|composite|tubular|pvc.*pisc|acero|elevada/.test(k)) a.push("A5");
  if (/pièces|ersatz|onderdelen|duikplank|glijbaan|zwembad|pompe|recinzione|copertura|couverture|boia|escada|pedra|piscine|pool.*zaun|pooltreppe/.test(k)) a.push("A6");
  return a.length ? a : ["A1"];
}
function classifyCluster(kw: string): string {
  const k = (kw || "").toLowerCase();
  if (/limpiafondos|robot.*pisc|dolphin|zodiac|wybot|beatbot|aquabot|aquasense|sora|osprey|carrera|liberty|skimmi|navigator|tiger/.test(k)) return "Robots y limpiafondos";
  if (/depuradora|filtro.*arena|filtro.*pisc|aster|star.*plus|vidrio.*filtrante|brio/.test(k)) return "Filtración";
  if (/clorador|cloro|sal.*pisc|innowater|smc|idegis|bspool|ph.*pisc|regulador.*ph|dosificador|bomba.*dos|seko|tekna|kontrol|orp|redox/.test(k)) return "Tratamiento";
  if (/fotometro|fotómetro|poollab|aquachek|lovibond|hanna|turbidimetro|medidor|test.*agua/.test(k)) return "Análisis";
  if (/cubierta|cobertor|invern|lona|manta.*termic/.test(k)) return "Cubiertas";
  if (/bomba.*pisc|bomba.*espa|espa.*silen|espa.*iris|kripsol|hayward|aquagem|presscontrol/.test(k)) return "Bombas";
  if (/valla.*pisc|pool.*alarm|alarma|recinzione|pool.*zaun/.test(k)) return "Seguridad";
  if (/gresite|escalera|bordadura|trampolim|duikplank|plato.*ducha|foco.*pisc|lumiplus|liner|sika/.test(k)) return "Accesorios";
  if (/desmontable|gre|intex|composite|tubular|pvc.*pisc|acero/.test(k)) return "Desmontables";
  if (/recambio|repuesto|part|pièces|ersatz|spare|replacement|\d{7,}/.test(k)) return "Recambios";
  if (/quimipool|astralpool|kripsol|poolex|fluidra|qp/.test(k)) return "Marca";
  return "Otros";
}
function defaultArchetypes() {
  return [
    {id:"A1",name:"El Preparador de Temporada",icon:"🏊",desc:"Activa su piscina en abril-mayo. Depuradoras, filtros, químicos. Ticket €200-600.",pct:25,color:"#18181b"},
    {id:"A2",name:"El Cazador de Robots",icon:"🤖",desc:"Investiga robots limpiafondos sin cable. Compara Dolphin, Zodiac, Wybot. Ticket €400-1.200.",pct:20,color:"#3f3f46"},
    {id:"A3",name:"El Manitas Reparador",icon:"🔧",desc:"Recambios exactos por referencia y despieces. Compra recurrente. Ticket €30-150.",pct:18,color:"#52525b"},
    {id:"A4",name:"El Técnico Profesional",icon:"⚙️",desc:"Bombas dosificadoras Seko, fotómetros Hanna/Lovibond, ORP. B2B.",pct:15,color:"#71717a"},
    {id:"A5",name:"El Propietario de Desmontable",icon:"🏠",desc:"Piscinas Gre, accesorios básicos, soluciones económicas. Ticket €100-400.",pct:12,color:"#a1a1aa"},
    {id:"A6",name:"El Buscador Internacional",icon:"🌍",desc:"Busca en FR, DE, NL, PT, IT. Pièces détachées, Ersatzteile. Cross-border.",pct:10,color:"#d4d4d8"},
  ];
}
function padTo6(archs: any[]|null|undefined) {
  const defs = defaultArchetypes();
  const colors = ["#18181b","#3f3f46","#52525b","#71717a","#a1a1aa","#d4d4d8"];
  if (!archs || archs.length === 0) return defs;
  const result: any[] = [];
  for (let i = 0; i < 6; i++) {
    const id = "A" + (i + 1);
    const src = archs[i] || defs[i];
    result.push({ ...src, id, color: colors[i] });
  }
  return result;
}
function buildLocalInsights(kws: any[], archIds: string[]) {
  const PH = ["Descubrimiento","Investigación","Evaluación","Decisión","Compra","Post-venta"];
  const archFeel: Record<string,string> = {A1:"Abrumado por tantas opciones",A2:"Frustrado si no encuentra la pieza",A3:"Dispuesto a invertir pero necesita estar seguro",A4:"Profesional, busca fiabilidad"};
  const phaseFeel: Record<string,string> = {"Descubrimiento":"Empieza a buscar, aún no sabe qué necesita","Investigación":"Compara opciones y tecnologías","Evaluación":"Compara precios y modelos concretos","Decisión":"Sabe lo que quiere, busca la mejor oferta","Compra":"Busca la tienda directamente","Post-venta":"Necesita soporte o recambios"};
  const ins: Record<string,any> = {};
  archIds.forEach(aid => {
    ins[aid] = {};
    const aKws = kws.filter((k: any) => k.archs?.includes(aid));
    PH.forEach(ph => {
      const pKws = aKws.filter((k: any) => k.phase === ph);
      const top = pKws.length ? [...pKws].sort((a: any, b: any) => b.imp - a.imp)[0] : null;
      const totalImp = pKws.reduce((s: number, k: any) => s + k.imp, 0);
      const avgPos = pKws.filter((k: any) => k.pos > 0).length ? +(pKws.filter((k: any) => k.pos > 0).reduce((s: number, k: any) => s + k.pos, 0) / pKws.filter((k: any) => k.pos > 0).length).toFixed(1) : 0;
      const pains: string[] = []; const gains: string[] = [];
      if (!pKws.length) { pains.push("Sin presencia en esta fase"); gains.push("Oportunidad de crear contenido"); }
      else {
        if (avgPos > 20) pains.push("Pos. media " + avgPos + " — baja visibilidad");
        else if (avgPos > 10) pains.push("Pos. media " + avgPos + " — fuera de página 1");
        const gapKws = pKws.filter((k: any) => k.source?.startsWith("gap:"));
        if (gapKws.length) pains.push(gapKws.length + " keywords donde competidores rankean y tú no");
        if (top && top.pos > 0 && top.pos <= 5) gains.push('"' + top.kw + '" en pos.' + top.pos);
        if (totalImp > 500) gains.push(totalImp.toLocaleString() + " imp/mes");
        if (pKws.length > 3) gains.push(pKws.length + " keywords activas");
      }
      if (!pains.length) pains.push("Sin problemas destacados");
      if (!gains.length) gains.push("Potencial por explorar");
      ins[aid][ph] = {
        t: top ? 'Busca "' + top.kw + '". ' + (phaseFeel[ph] || '') + '.' : (phaseFeel[ph] || '') + '.',
        f: archFeel[aid] || "Necesita orientación",
        p: pains, g: gains,
      };
    });
  });
  return ins;
}

function generateDashboardHTML(data: any, journey: any, aiEnabled: boolean, aiLoading: boolean): string {
  const PH=["Descubrimiento","Investigación","Evaluación","Decisión","Compra","Post-venta"];
  const PCS=["#3f3f46","#52525b","#71717a","#27272a","#18181b","#a1a1aa"];
  const CC=["#18181b","#52525b","#71717a","#a1a1aa","#d4d4d8"];

  const kws=journey?.keywords_classified||data.keywords.slice(0,60).map((k:any,i:number)=>({...k,phase:PH[Math.min(Math.floor(i/10),5)],intent:"Informacional",archs:["A1"]}));
  const archs=journey?.archetypes||[{id:"A1",name:"Perfil 1",icon:"\ud83d\udc64",desc:"Cargando...",pct:25,color:"#18181b"},{id:"A2",name:"Perfil 2",icon:"\ud83d\udc64",desc:"Cargando...",pct:20,color:"#3f3f46"},{id:"A3",name:"Perfil 3",icon:"\ud83d\udc64",desc:"Cargando...",pct:18,color:"#52525b"},{id:"A4",name:"Perfil 4",icon:"\ud83d\udc64",desc:"Cargando...",pct:15,color:"#71717a"},{id:"A5",name:"Perfil 5",icon:"\ud83d\udc64",desc:"Cargando...",pct:12,color:"#a1a1aa"},{id:"A6",name:"Perfil 6",icon:"\ud83d\udc64",desc:"Cargando...",pct:10,color:"#d4d4d8"}];
  const pains=journey?.pain_points||[];
  const gaps=journey?.content_gaps||[];
  const recs=journey?.recommendations||[];
  const ins=journey?.insights||{};
  const activeComps=data.competitors||[];
  const compGaps=data.compGaps||{};
  const compShared=data.compShared||{};
  const domOvw=data.domainOverview||{};

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#fafafa;--surface:#ffffff;--surface2:#f4f4f5;--surface3:#e4e4e7;--border:#e4e4e7;--border2:#d4d4d8;--ring:rgba(9,9,11,.08);--text:#09090b;--text2:#3f3f46;--text3:#71717a;--text4:#a1a1aa;--accent:#18181b;--accent2:#27272a;--gold:#0ea5e9;--a1:#18181b;--a2:#52525b;--a3:#a1a1aa;--a4:#d4d4d8;--danger:#ef4444;--warn:#f59e0b;--success:#10b981;--radius:8px;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
*{margin:0;padding:0;box-sizing:border-box}body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.5;font-size:14px;-webkit-font-smoothing:antialiased;overflow-x:hidden}
.mono{font-family:var(--mono)}
header{background:var(--accent);padding:1.25rem 2rem;border-bottom:1px solid var(--border)}
header h1{font-size:1rem;font-weight:600;color:#fafafa;letter-spacing:-.02em}
header p{color:#a1a1aa;font-size:.8rem;margin-top:.15rem}
.kpi-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));border-bottom:1px solid var(--border);background:var(--surface)}
.kpi{padding:.85rem 1rem;border-right:1px solid var(--border)}.kpi:last-child{border-right:none}
.kpi-val{font-family:var(--mono);font-size:1.5rem;font-weight:600;color:var(--text);letter-spacing:-.03em;line-height:1.2}
.kpi-val.gold{color:var(--gold)}
.kpi-label{font-size:.7rem;color:var(--text3);margin-top:.1rem;font-weight:500}
.tabs-nav{display:flex;gap:0;padding:0 2rem;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10;height:40px;align-items:stretch;overflow-x:auto;scrollbar-width:none}
.tabs-nav::-webkit-scrollbar{display:none}
.tab-btn{padding:0 1rem;cursor:pointer;font-size:.8rem;font-weight:500;color:var(--text3);border:none;background:none;font-family:var(--font);white-space:nowrap;transition:color .15s;position:relative;display:flex;align-items:center}
.tab-btn:hover{color:var(--text)}
.tab-btn.on{color:var(--text);font-weight:600}
.tab-btn.on::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--text);border-radius:1px 1px 0 0}
.tab-pnl{display:none;padding:1.5rem 2rem;max-width:1600px;margin:0 auto}.tab-pnl.on{display:block}
.dashboard{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;transition:box-shadow .2s}
.card:hover{box-shadow:0 1px 3px var(--ring)}.card.full{grid-column:1/-1}
.card-title{font-size:.8rem;font-weight:600;color:var(--text);margin-bottom:.85rem;display:flex;align-items:center;gap:.4rem;letter-spacing:-.01em}
.card-title .dot{width:6px;height:6px;border-radius:50%;background:var(--text4);flex-shrink:0}
.chart-wrap{position:relative;height:280px}
.arch-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem}
.arch-card{border-radius:var(--radius);padding:1rem;border:1px solid var(--border);background:var(--surface);position:relative;overflow:hidden;transition:border-color .2s}
.arch-card:hover{border-color:var(--border2)}
.arch-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.arch-card:nth-child(1)::before{background:var(--a1)}.arch-card:nth-child(2)::before{background:var(--a2)}.arch-card:nth-child(3)::before{background:var(--a3)}.arch-card:nth-child(4)::before{background:var(--a4)}
.arch-card:nth-child(5)::before{background:#a1a1aa}
.arch-card:nth-child(6)::before{background:#d4d4d8}
.arch-card h3{font-size:.82rem;font-weight:600;margin-bottom:.25rem;letter-spacing:-.01em}
.arch-card .desc{font-size:.75rem;color:var(--text3);line-height:1.45}
.arch-card .weight-val{font-family:var(--mono);font-size:1.5rem;font-weight:600;letter-spacing:-.03em}
.arch-card .weight-lbl{font-size:.65rem;color:var(--text4);font-weight:500}
.heatmap{width:100%;border-collapse:collapse}
.heatmap th{font-size:.7rem;font-weight:500;color:var(--text3);padding:.5rem;text-align:center}
.heatmap th.row-h{text-align:left;color:var(--text2);font-weight:600}
.heatmap td{text-align:center;padding:.5rem;font-family:var(--mono);font-size:.8rem;font-weight:600;border-radius:6px}
.heatmap td .sub{display:block;font-family:var(--font);font-size:.65rem;font-weight:400;opacity:.7;margin-top:1px}
.journey-map{display:grid;grid-template-columns:110px repeat(6,1fr);gap:2px;font-size:.75rem}
.jm-phase{text-align:center;padding:.5rem .15rem;font-weight:600;font-size:.65rem;text-transform:uppercase;letter-spacing:.04em;border-radius:6px 6px 0 0;color:#fff}
.jm-arch-label{display:flex;align-items:center;padding:.25rem .4rem;font-weight:600;font-size:.75rem;border-radius:6px 0 0 6px}
.jm-cell{background:var(--surface);padding:.5rem;border-radius:4px;border:1px solid var(--border);min-height:70px;transition:border-color .2s}
.jm-cell:hover{border-color:var(--border2)}
.jm-cell .kw-list{list-style:none;font-size:.72rem;color:var(--text2);line-height:1.4}
.jm-cell .kw-list .vol{font-family:var(--mono);font-size:.65rem;color:var(--text4)}
.jm-cell .insight-body{max-height:0;overflow:hidden;transition:max-height .3s,opacity .2s;opacity:0}
.jm-cell .insight-body.open{max-height:800px;opacity:1}
.ins-toggle{font-size:.65rem;color:var(--text3);cursor:pointer;display:inline-flex;align-items:center;gap:.2rem;padding:.15rem .4rem;border-radius:4px;background:var(--surface2);border:1px solid var(--border);margin-top:.3rem;font-weight:500;transition:all .15s}
.ins-toggle:hover{background:var(--surface3)}
.insight-body{font-size:.72rem;color:var(--text2);line-height:1.4;margin-top:.15rem;padding-top:.25rem;border-top:1px solid var(--border)}
.insight-body .ib-l{font-weight:600;color:var(--text);font-size:.68rem;margin-top:.25rem}
.insight-body .pain{color:#dc2626;font-size:.7rem}
.insight-body .gain{color:var(--success);font-size:.7rem}
.pain-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:.65rem}
.pain-card{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--danger);border-radius:var(--radius);padding:.85rem 1rem;transition:border-color .2s}
.pain-card:hover{border-color:var(--border2)}
.pain-card .pt{font-size:.82rem;font-weight:600;color:var(--text);margin-bottom:.2rem}
.pain-card .pd{font-size:.75rem;color:var(--text3);line-height:1.45}
.pain-card .pm{display:flex;gap:.3rem;font-size:.65rem;color:var(--text4);flex-wrap:wrap;margin-top:.35rem}
.pain-card .pm span{padding:.12rem .35rem;border-radius:4px;background:var(--surface2);font-weight:500}
.rec-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem;margin-bottom:.5rem;transition:border-color .2s}
.rec-card:hover{border-color:var(--border2)}
.rec-card .rc-title{font-size:.82rem;font-weight:600}
.rec-card .rc-tag{font-size:.65rem;padding:.12rem .4rem;border-radius:4px;font-weight:600}
.rec-card .rc-desc{font-size:.75rem;color:var(--text3);line-height:1.5;margin-top:.15rem}
.rec-card .rc-meta{display:flex;gap:.35rem;margin-top:.3rem;font-size:.65rem;color:var(--text4);flex-wrap:wrap}
.rec-card .rc-meta span{padding:.1rem .35rem;border-radius:4px;background:var(--surface2)}
.kw-table-wrap{overflow:auto;scrollbar-width:thin;border:1px solid var(--border);border-radius:var(--radius)}
.kw-table{width:100%;border-collapse:collapse;font-size:.8rem}
.kw-table thead{position:sticky;top:0;z-index:5}
.kw-table th{background:var(--surface2);padding:.6rem .5rem;text-align:left;font-size:.7rem;font-weight:600;color:var(--text3);border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap}
.kw-table th:hover{color:var(--text)}
.kw-table td{padding:.5rem;border-bottom:1px solid var(--surface3)}
.kw-table tr:hover td{background:var(--surface2)}
.pill{display:inline-block;padding:.12rem .4rem;border-radius:4px;font-size:.7rem;font-weight:500;background:var(--surface2);color:var(--text2)}
.sov-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:.75rem}
.sov-label{width:110px;color:var(--text2);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sov-bar{flex:1;height:24px;background:var(--surface3);border-radius:4px;overflow:hidden;display:flex}
.sov-seg{height:100%;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:600;color:#fff;min-width:1px}
.sov-total{font-family:var(--mono);font-size:.7rem;color:var(--text3);width:55px;text-align:right}
.wl-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px}
.wl-box{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:10px;text-align:center}
.wl-box .wl-v{font-family:var(--mono);font-size:1.25rem;font-weight:600}
.wl-box .wl-l{font-size:.65rem;color:var(--text4);font-weight:500}

.filters{display:flex;gap:.4rem;padding:.5rem 2rem;flex-wrap:wrap;align-items:center;background:var(--surface);border-bottom:1px solid var(--border)}
.filters label{font-size:.7rem;color:var(--text4);font-weight:500}
.filter-group{display:flex;gap:.25rem;align-items:center;margin-right:1rem}
.fbtn{padding:.25rem .55rem;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text3);font-family:var(--font);font-size:.75rem;font-weight:500;cursor:pointer;transition:all .15s}
.fbtn:hover{border-color:var(--border2);color:var(--text)}
.fbtn.active{background:var(--accent);border-color:var(--accent);color:#fafafa}
.search-box{padding:.3rem .6rem;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-family:var(--font);font-size:.8rem;width:180px;outline:none;transition:border-color .15s,box-shadow .15s}
.search-box:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--ring)}
.ai-loading{text-align:center;padding:2rem;color:var(--text4)}
.ai-loading .spinner{display:inline-block;width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--text3);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:1100px){.dashboard{grid-template-columns:1fr}.arch-cards{grid-template-columns:repeat(2,1fr)}}
@media(max-width:768px){.tabs-nav{padding:0 1rem}.tab-pnl{padding:1rem}.arch-cards{grid-template-columns:1fr 1fr}.journey-map{min-width:900px}header{padding:1rem 1.5rem}}
::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}
</style></head><body>
<header><h1>Customer Journey SEO \u2014 ${data.domain}</h1><p>${kws.length} keywords \u00d7 ${activeComps.length} competidores${aiEnabled?" + Claude IA":""}</p></header>
<div class="kpi-strip" id="kpiStrip"></div>
<div class="tabs-nav">
<button class="tab-btn on" data-tab="journey">Journey</button>
<button class="tab-btn" data-tab="overview">Overview</button>
<button class="tab-btn" data-tab="opps">Oportunidades</button>
${activeComps.length?'<button class="tab-btn" data-tab="comps">Competidores</button>':""}
<button class="tab-btn" data-tab="keywords">Keywords</button>
<button class="tab-btn" data-tab="revenue">Revenue</button>
${activeComps.length?'<button class="tab-btn" data-tab="gaps">Gaps</button>':""}
${recs.length||aiLoading?'<button class="tab-btn" data-tab="recs">IA</button>':""}
</div>
<div class="filters"><div class="filter-group"><label>Arquetipo:</label><span id="archFilters"></span></div><div class="filter-group"><label>Fase:</label><span id="phaseFilters"></span></div><div class="filter-group" style="margin-left:auto"><input type="text" class="search-box" id="kwSearch" placeholder="Buscar keyword..."></div></div>
<div class="tab-pnl on" id="tab-journey"><div class="dashboard">
<div class="card full"><div class="card-title"><span class="dot"></span>Arquetipos</div><div class="arch-cards" id="archCards"></div></div>
<div class="card full"><div class="card-title"><span class="dot"></span>Heatmap</div><div style="overflow-x:auto"><table class="heatmap" id="heatmap" style="min-width:600px"></table></div></div>
<div class="card full"><div class="card-title"><span class="dot" style="background:var(--warn)"></span>Journey Map</div><div style="overflow-x:auto;max-width:100%"><div class="journey-map" id="journeyMap"></div></div></div>
${pains.length?'<div class="card full"><div class="card-title"><span class="dot" style="background:var(--danger)"></span>Pain Points</div><div class="pain-grid" id="painGrid"></div></div>':(aiLoading?'<div class="card full"><div class="card-title"><span class="dot" style="background:var(--danger)"></span>Pain Points</div><div class="ai-loading"><span class="spinner"></span>Analizando...</div></div>':'')}
</div></div>
<div class="tab-pnl" id="tab-overview"><div class="dashboard">
<div class="card"><div class="card-title"><span class="dot"></span>Imp vs Pos</div><div class="chart-wrap"><canvas id="bubbleChart"></canvas></div></div>
<div class="card"><div class="card-title"><span class="dot"></span>Clicks fase\u00d7arq</div><div class="chart-wrap"><canvas id="phaseBar"></canvas></div></div>
<div class="card"><div class="card-title"><span class="dot"></span>Intenci\u00f3n</div><div class="chart-wrap"><canvas id="intentPie"></canvas></div></div>
<div class="card"><div class="card-title"><span class="dot"></span>Radar</div><div class="chart-wrap"><canvas id="radarChart"></canvas></div></div>
<div class="card full"><div class="card-title"><span class="dot"></span>Top P\u00e1ginas GA4</div><div id="pagesTable"></div></div>
</div></div>
<div class="tab-pnl" id="tab-opps"><div class="dashboard">
<div class="card full"><div class="card-title"><span class="dot" style="background:var(--gold)"></span>Scatter: KD vs Volumen</div><div class="chart-wrap" style="height:400px"><canvas id="scatterChart"></canvas></div><div style="display:flex;gap:8px;margin-top:6px;font-size:.75rem;color:var(--text3)"><span>● Quick Win (KD<25)</span><span>● Estrat\u00e9gica (25-40)</span><span>● Competida (>40)</span><span>○ Sin KD</span></div></div>
</div></div>
${activeComps.length?`<div class="tab-pnl" id="tab-comps"><div class="dashboard">
<div class="card full"><div class="card-title"><span class="dot" style="background:var(--gold)"></span>Competidores \u2014 Share of Voice + Detalle</div>
<div style="margin-bottom:12px"><table class="kw-table"><tr style="background:rgba(9,9,11,.06)"><th style="text-align:left">Dominio</th><th style="text-align:right">ETV</th><th style="text-align:right">KWs</th><th style="text-align:right">Shared</th></tr>
<tr style="background:rgba(9,9,11,.04)"><td style="font-weight:700">${data.domain}</td><td style="text-align:right;font-family:var(--mono)">${(domOvw.etv||0).toLocaleString()}</td><td style="text-align:right;font-family:var(--mono)">${(domOvw.count||0).toLocaleString()}</td><td style="text-align:right">\u2014</td></tr>
${activeComps.map((c:any,i:number)=>`<tr style="cursor:pointer" onclick="toggleDetail('${c.domain}')"><td ><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${CC[i%CC.length]};margin-right:5px"></span>${c.domain}</td><td style="text-align:right;font-family:var(--mono)">${(c.etv||0).toLocaleString()}</td><td style="text-align:right;font-family:var(--mono)">${(c.count||0).toLocaleString()}</td><td style="text-align:right;font-family:var(--mono)">${(c.shared||0).toLocaleString()}</td></tr>`).join("")}
</table></div>
<div id="sovBarsArea"></div>
<div id="compDetailArea"></div>
</div></div></div>`:""}
<div class="tab-pnl" id="tab-keywords"><div class="dashboard"><div class="card full"><div class="card-title"><span class="dot"></span>Keywords \u00b7 <span id="tableCount" style="color:var(--accent)"></span></div><div class="kw-table-wrap" style="max-height:500px"><table class="kw-table" id="kwTable" style="min-width:700px"><thead><tr></tr></thead><tbody></tbody></table></div></div></div></div>
<div class="tab-pnl" id="tab-revenue"><div class="dashboard"><div class="card full"><div class="card-title"><span class="dot" style="background:var(--success)"></span>Revenue estimado</div><div id="revenueContent"></div></div></div></div>
${activeComps.length?`<div class="tab-pnl" id="tab-gaps"><div class="dashboard"><div class="card full"><div class="card-title"><span class="dot" style="background:var(--gold)"></span>Gaps por competidor (DataForSEO)</div><div id="dfsGapList"></div></div></div></div>`:""}
${recs.length||aiLoading?`<div class="tab-pnl" id="tab-recs"><div class="dashboard"><div class="card full"><div class="card-title"><span class="dot" style="background:var(--gold)"></span>\ud83e\udd16 Recomendaciones IA</div><div id="recsContent">${aiLoading?'<div class="ai-loading"><span class="spinner"></span>Generando...</div>':''}</div></div></div></div>`:""}

<script>
var PH=${JSON.stringify(PH)};var PCS=${JSON.stringify(PCS)};var CC=${JSON.stringify(CC)};
var KW=${JSON.stringify(kws)};var ARCHS=${JSON.stringify(archs)};var PAINS=${JSON.stringify(pains)};var GAPS=${JSON.stringify(gaps)};var RECS=${JSON.stringify(recs)};var INS=${JSON.stringify(ins)};var PAGES=${JSON.stringify(data.ga4Pages?.slice(0,30)||[])};
var COMPS=${JSON.stringify(activeComps)};var COMP_GAPS=${JSON.stringify(compGaps)};var COMP_SHARED=${JSON.stringify(compShared)};
var AR=ARCHS.map(function(a){return a.id});var AC={};ARCHS.forEach(function(a){AC[a.id]=a.color});
var IC={Informacional:"#71717a",Comercial:"#a1a1aa",Transaccional:"#3f3f46",Navegacional:"#d4d4d8",commercial:"#a1a1aa",informational:"#71717a",transactional:"#3f3f46",navigational:"#d4d4d8"};
var aA=new Set(AR),aP="all",sT="",sC="clicks",sD=-1,expandedComp=null;

document.querySelectorAll('.tab-btn').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('.tab-btn').forEach(function(x){x.classList.remove('on')});document.querySelectorAll('.tab-pnl').forEach(function(x){x.classList.remove('on')});b.classList.add('on');var t=document.getElementById('tab-'+b.dataset.tab);if(t)t.classList.add('on')})});

function fil(){return KW.filter(function(k){if(k.archs&&!k.archs.some(function(a){return aA.has(a)}))return false;if(aP!=="all"&&k.phase!==aP)return false;if(sT&&k.kw.toLowerCase().indexOf(sT.toLowerCase())===-1)return false;return true})}
function fmt(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e4)return(n/1e3).toFixed(0)+'K';return n.toLocaleString('es-ES')}

var bC,pB,iP,rC,sCh;
function initCharts(){
Chart.defaults.color='#71717a';Chart.defaults.borderColor='#e4e4e7';Chart.defaults.font.family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";Chart.defaults.font.size=11;Chart.defaults.plugins.legend.labels.boxWidth=10;Chart.defaults.plugins.legend.labels.padding=12;Chart.defaults.plugins.legend.labels.usePointStyle=true;Chart.defaults.plugins.legend.labels.pointStyle='circle';
bC=new Chart(document.getElementById('bubbleChart'),{type:'bubble',data:{datasets:[]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{title:{display:true,text:'Posici\u00f3n'},min:0,max:50},y:{title:{display:true,text:'Impresiones'},min:0}},plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){var d=c.raw;return[d.label,'Imp:'+d.y+' Pos:'+d.x]}}}}}});
pB=new Chart(document.getElementById('phaseBar'),{type:'bar',data:{labels:PH,datasets:[]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:9}}}}}});
iP=new Chart(document.getElementById('intentPie'),{type:'doughnut',data:{labels:[],datasets:[{data:[],backgroundColor:[]}]},options:{responsive:true,maintainAspectRatio:false,cutout:'55%',plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:9}}}}}});
rC=new Chart(document.getElementById('radarChart'),{type:'radar',data:{labels:PH,datasets:[]},options:{responsive:true,maintainAspectRatio:false,scales:{r:{beginAtZero:true,ticks:{display:false},pointLabels:{font:{size:8}}}},plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:9}}}}}});
// FIX: Scatter chart for KD vs Vol
var scEl=document.getElementById('scatterChart');
if(scEl){
var cats={};KW.forEach(function(k){var kd=k.kd||0;var vol=k.vol||k.imp||0;var cat,col;
if(kd>0&&kd<25&&vol>100){cat='Quick Win';col='#18181b'}else if(kd>=25&&kd<=40){cat='Estrat\u00e9gica';col='#71717a'}else if(kd>40){cat='Competida';col='#a1a1aa'}else{cat='Sin KD';col='#d4d4d8'}
if(!cats[cat])cats[cat]={col:col,d:[]};cats[cat].d.push({x:kd||Math.random()*5,y:Math.min(vol,20000),r:Math.max(3,Math.sqrt(vol/200)),label:k.kw})});
sCh=new Chart(scEl,{type:'bubble',data:{datasets:Object.keys(cats).map(function(n){return{label:n,data:cats[n].d,backgroundColor:cats[n].col+'55',borderColor:cats[n].col,borderWidth:1}})},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{usePointStyle:true,pointStyle:'circle',font:{size:9}}},tooltip:{callbacks:{label:function(c){var d=c.raw;return[d.label,'Vol:'+d.y,'KD:'+d.x.toFixed(0)]}}}},scales:{x:{title:{display:true,text:'KD'},min:0,max:50},y:{title:{display:true,text:'Volumen/mes'},ticks:{callback:function(v){return v>=1000?(v/1000)+'K':v}}}}}})
}}

function updateAll(){var d=fil();var tC=d.reduce(function(s,k){return s+k.clicks},0);var tI=d.reduce(function(s,k){return s+k.imp},0);
var allGap=0;COMPS.forEach(function(c){allGap+=(COMP_GAPS[c.domain]||[]).length});
document.getElementById('kpiStrip').innerHTML=[{v:d.length,l:'Keywords'},{v:tC.toLocaleString(),l:'Clicks'},{v:tI.toLocaleString(),l:'Impresiones'},{v:'\u20ac${data.revenue.total}',l:'Revenue 30d',c:'gold'},{v:COMPS.length,l:'Competidores'},{v:allGap,l:'Gap KWs'}].map(function(k){return '<div class="kpi"><div class="kpi-val '+(k.c||'')+'">'+k.v+'<\/div><div class="kpi-label">'+k.l+'<\/div><\/div>'}).join('');
updAC();updBub(d);updPB(d);updIP(d);updRad(d);updHM(d);updPn();updJM(d);updGap();updRec();updTbl(d);updPages();updRev(d);updDfsGaps();updSoV()}

function updAC(){document.getElementById('archCards').innerHTML=ARCHS.filter(function(a){return aA.has(a.id)}).map(function(a){return '<div class="arch-card" style="border-top:3px solid '+a.color+'"><h3 style="color:'+a.color+'">'+a.icon+' '+a.name+'<\/h3><div class="desc">'+a.desc+'<\/div><div style="display:flex;gap:.6rem"><div><div class="weight-val" style="color:'+a.color+'">'+a.pct+'%<\/div><div class="weight-lbl">Tr\u00e1fico<\/div><\/div><\/div><\/div>'}).join('')}
function updBub(d){var t=d.slice(0,30);var mx=Math.max.apply(null,t.map(function(k){return k.imp}))||1;bC.data.datasets=[{data:t.map(function(k){return{x:k.pos,y:k.imp,r:Math.max(3,Math.sqrt(k.clicks/5)*3),label:k.kw}}),backgroundColor:'rgba(24,24,27,0.15)',borderColor:'#18181b',borderWidth:1}];bC.options.scales.y.max=mx*1.1;bC.update()}
function updPB(d){pB.data.datasets=ARCHS.filter(function(a){return aA.has(a.id)}).map(function(a){return{label:a.name,data:PH.map(function(p){return d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).reduce(function(s,k){return s+k.clicks},0)}),backgroundColor:a.color+'33',borderColor:a.color,borderWidth:1,borderRadius:3}});pB.update()}
function updIP(d){var g={};d.forEach(function(k){var i=k.intent||'';g[i]=(g[i]||0)+k.clicks});var l=Object.keys(g);iP.data.labels=l;iP.data.datasets[0].data=l.map(function(x){return g[x]});iP.data.datasets[0].backgroundColor=l.map(function(x){return IC[x]||'#666'});iP.update()}
function updRad(d){rC.data.datasets=ARCHS.filter(function(a){return aA.has(a.id)}).map(function(a){return{label:a.name,data:PH.map(function(p){var ks=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1});return ks.length?Math.round(ks.reduce(function(s,k){return s+k.clicks},0)/ks.length):0}),borderColor:a.color,backgroundColor:a.color+'15',pointBackgroundColor:a.color,borderWidth:2,pointRadius:3}});rC.update()}
function updHM(d){var h='<tr><th class="row-h"><\/th>';PH.forEach(function(p,i){h+='<th style="color:'+PCS[i]+'">'+p+'<\/th>'});h+='<\/tr>';var mx=1;ARCHS.forEach(function(a){PH.forEach(function(p){var v=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).reduce(function(s,k){return s+k.clicks},0);if(v>mx)mx=v})});ARCHS.filter(function(a){return aA.has(a.id)}).forEach(function(a){h+='<tr><th class="row-h" style="color:'+a.color+'">'+a.name+'<\/th>';PH.forEach(function(p){var v=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).reduce(function(s,k){return s+k.clicks},0);var n=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1}).length;var op=Math.min(.9,v/mx+.1);h+='<td style="background:rgba(9,9,11,'+op+');color:'+(op>.5?'#fff':'var(--text)')+'">'+v+'<span class="sub">'+n+' kw<\/span><\/td>'});h+='<\/tr>'});document.getElementById('heatmap').innerHTML=h}
function updPn(){var el=document.getElementById('painGrid');if(!el)return;el.innerHTML=PAINS.filter(function(p){return!p.archs||p.archs.some(function(a){return aA.has(a)})}).map(function(p){return '<div class="pain-card"><div class="pt">'+p.title+'<\/div><div class="pd">'+p.desc+'<\/div><div class="pm">'+(p.phases||[]).map(function(ph){return '<span>'+ph+'<\/span>'}).join('')+(p.archs||[]).map(function(a){return '<span style="background:'+(AC[a]||'#71717a')+'22;color:'+(AC[a]||'#71717a')+'">'+a+'<\/span>'}).join('')+'<\/div><\/div>'}).join('')}
function updJM(d){var el=document.getElementById('journeyMap');var h='<div><\/div>';PH.forEach(function(p,i){h+='<div class="jm-phase" style="background:'+PCS[i]+'">'+p+'<\/div>'});ARCHS.filter(function(a){return aA.has(a.id)}).forEach(function(a){h+='<div class="jm-arch-label" style="color:'+a.color+'">'+a.icon+' '+a.name+'<\/div>';PH.forEach(function(p){var ks=d.filter(function(k){return k.phase===p&&k.archs&&k.archs.indexOf(a.id)!==-1});var uid=a.id+'_'+p.replace(/[^a-zA-Z]/g,'');var ins_data=INS[a.id]&&INS[a.id][p]?INS[a.id][p]:null;h+='<div class="jm-cell"><ul class="kw-list">';ks.slice(0,4).forEach(function(k){h+='<li>'+k.kw+' <span class="vol">'+k.clicks+'c<\/span><\/li>'});h+='<\/ul>';if(ins_data){h+='<div class="ins-toggle" onclick="tog(&quot;ins_'+uid+'&quot;,this)">\u2630 Insight<\/div><div id="ins_'+uid+'" class="insight-body"><div class="ib-l">\ud83d\udcad Piensa<\/div>'+(ins_data.t||'')+'<div class="ib-l">\u2764\ufe0f Siente<\/div>'+(ins_data.f||'');if(ins_data.p&&ins_data.p.length)h+='<div class="ib-l">\ud83d\udd34 Pains<\/div>'+ins_data.p.map(function(x){return '<div class="pain">\u2022 '+x+'<\/div>'}).join('');if(ins_data.g&&ins_data.g.length)h+='<div class="ib-l">\ud83d\udfe2 Gains<\/div>'+ins_data.g.map(function(x){return '<div class="gain">\u2022 '+x+'<\/div>'}).join('');h+='<\/div>'}h+='<\/div>'})});el.innerHTML=h}
function updGap(){var el=document.getElementById('gapList');if(!el)return;el.innerHTML=GAPS.map(function(g){return '<div class="gap-item" style="border-left-color:'+(AC[g.arch]||'var(--accent)')+'"><div><div class="gt">'+g.title+'<\/div><div class="gk">'+g.kws+'<\/div><\/div><div style="text-align:right"><span class="gpb '+g.prio+'">'+g.prio+'<\/span><\/div><\/div>'}).join('')}
function updRec(){var el=document.getElementById('recsContent');if(!el||!RECS.length)return;el.innerHTML=RECS.map(function(r){return '<div class="rec-card" style="border-left:3px solid '+(r.priority==='ALTA'?'#18181b':'#71717a')+'"><div style="display:flex;gap:.3rem;align-items:center;margin-bottom:.2rem;flex-wrap:wrap"><span class="rc-title">'+r.title+'<\/span><span class="rc-tag" style="background:rgba(185,28,28,.1);color:#dc2626">'+r.priority+'<\/span><\/div><div class="rc-desc">'+r.description+'<\/div><div class="rc-meta"><span>\ud83d\udccd '+(r.phase||'')+'<\/span><span>\ud83d\udcb0 '+(r.impact||'')+'<\/span><span>\u23f1 '+(r.effort||'')+'<\/span><\/div><\/div>'}).join('')}
function updTbl(d){var hdr=document.querySelector('#kwTable thead tr');var cols=[{k:'kw',l:'Keyword'},{k:'phase',l:'Fase'},{k:'intent',l:'Intent'},{k:'clicks',l:'Clicks'},{k:'imp',l:'Imp'},{k:'kd',l:'KD'},{k:'pos',l:'Pos'}];hdr.innerHTML=cols.map(function(c){return '<th data-col="'+c.k+'">'+c.l+(sC===c.k?(sD>0?' \u25b2':' \u25bc'):'')+'<\/th>'}).join('');var sorted=d.slice().sort(function(a,b){var va=a[sC],vb=b[sC];if(typeof va==='string')return(va||'').localeCompare(vb||'')*sD;return((va||0)-(vb||0))*sD});document.getElementById('tableCount').textContent=sorted.length+' keywords';document.querySelector('#kwTable tbody').innerHTML=sorted.map(function(k){var pc=k.pos<=5?'color:var(--success)':k.pos<=10?'color:var(--warn)':'color:#dc2626';return '<tr><td>'+k.kw+'<\/td><td><span class="pill" style="background:rgba(9,9,11,.06)">'+(k.phase||'')+'<\/span><\/td><td><span class="pill" style="background:var(--surface2)">'+(k.intent||'')+'<\/span><\/td><td style="text-align:right;font-family:var(--mono);font-weight:600">'+k.clicks+'<\/td><td style="text-align:right;font-family:var(--mono)">'+k.imp.toLocaleString()+'<\/td><td style="text-align:right;font-family:var(--mono)">'+(k.kd||'\u2014')+'<\/td><td style="text-align:right;font-family:var(--mono);font-weight:600;'+pc+'">'+(k.pos||0)+'<\/td><\/tr>'}).join('')}
function updPages(){var el=document.getElementById('pagesTable');if(!el)return;el.innerHTML='<table class="kw-table"><thead><tr><th style="text-align:left">P\u00e1gina<\/th><th style="text-align:right">Sesiones<\/th><th style="text-align:right">Revenue<\/th><\/tr><\/thead><tbody>'+PAGES.slice(0,12).map(function(p){return '<tr><td style="max-width:350px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+p.page+'<\/td><td style="text-align:right;font-family:var(--mono)">'+p.sessions.toLocaleString()+'<\/td><td style="text-align:right;font-family:var(--mono)">\u20ac'+p.revenue.toLocaleString()+'<\/td><\/tr>'}).join('')+'<\/tbody><\/table>'}
function updRev(d){var el=document.getElementById('revenueContent');if(!el)return;var cr=0.0185,tk=224.85,ctr3=0.17;var rows=d.filter(function(k){return k.imp>100}).sort(function(a,b){return b.imp-a.imp}).slice(0,20).map(function(k){var cur=k.pos>0&&k.pos<=10?Math.round(k.imp*(k.pos<=3?ctr3:0.025)*cr*tk):0;var pot=Math.round(k.imp*ctr3*cr*tk);return '<tr><td>'+k.kw+'<\/td><td style="text-align:right;font-family:var(--mono)">'+k.imp.toLocaleString()+'<\/td><td style="text-align:right;font-family:var(--mono)">\u20ac'+cur.toLocaleString()+'<\/td><td style="text-align:right;font-family:var(--mono);color:var(--success)">\u20ac'+pot.toLocaleString()+'<\/td><\/tr>'});el.innerHTML='<p style="font-size:.75rem;color:var(--text3);margin-bottom:8px">Vol \u00d7 CTR \u00d7 1,85% conv \u00d7 \u20ac224,85<\/p><table class="kw-table"><thead><tr><th style="text-align:left">Keyword<\/th><th style="text-align:right">Imp.<\/th><th style="text-align:right">\u20ac/mes actual<\/th><th style="text-align:right">\u20ac/mes Top 3<\/th><\/tr><\/thead><tbody>'+rows.join('')+'<\/tbody><\/table>'}
function updDfsGaps(){var el=document.getElementById('dfsGapList');if(!el)return;var h='';COMPS.forEach(function(c,ci){var g=COMP_GAPS[c.domain]||[];if(!g.length)return;h+='<div style="margin-bottom:16px"><div class="card-title" style="margin-bottom:6px"><span class="dot"><\/span>'+c.domain+' \u2014 '+g.length+' gaps ('+g.reduce(function(s,x){return s+x.vol},0).toLocaleString()+'/mes)<\/div><div class="kw-table-wrap"><table class="kw-table"><thead><tr><th>Keyword<\/th><th style="text-align:right">Pos.<\/th><th style="text-align:right">Vol.<\/th><\/tr><\/thead><tbody>';g.sort(function(a,b){return b.vol-a.vol}).slice(0,10).forEach(function(x){h+='<tr><td>'+x.kw+'<\/td><td style="text-align:right;font-family:var(--mono);color:var(--text3)">'+x.posComp+'<\/td><td style="text-align:right;font-family:var(--mono);font-weight:600">'+x.vol.toLocaleString()+'<\/td><\/tr>'});h+='<\/tbody><\/table><\/div><\/div>'});el.innerHTML=h||'<div style="text-align:center;color:var(--text3);padding:12px">Sin datos de gaps<\/div>'}

// FIX 2: SoV bars rendering
function updSoV(){var el=document.getElementById('sovBarsArea');if(!el||!COMPS.length)return;
// Build cluster volumes from shared keywords
var clusters={};COMPS.forEach(function(c,ci){var sh=COMP_SHARED[c.domain]||[];sh.forEach(function(s){var cl=classifyCluster(s.kw);if(!clusters[cl])clusters[cl]={vt:0,q:0,comps:{}};clusters[cl].vt+=s.vol;if(s.posQ>0&&s.posQ<=20)clusters[cl].q+=s.vol;if(!clusters[cl].comps[c.domain])clusters[cl].comps[c.domain]=0;if(s.posC>0&&s.posC<=20)clusters[cl].comps[c.domain]+=s.vol})});
var clArr=Object.keys(clusters).sort(function(a,b){return clusters[b].vt-clusters[a].vt}).slice(0,8);
if(!clArr.length){el.innerHTML='';return}
var h='<div style="margin-bottom:8px;margin-top:12px"><span class="card-title" style="margin-bottom:0"><span class="dot"></span>Share of Voice por cluster</span><\/div>';
clArr.forEach(function(cl){var d=clusters[cl];var qPct=d.vt>0?Math.round(d.q/d.vt*100):0;
h+='<div class="sov-row"><div class="sov-label" title="'+cl+'">'+cl+'<\/div><div class="sov-bar">';
if(qPct>0)h+='<div class="sov-seg" style="width:'+qPct+'%;background:var(--accent)">'+qPct+'%<\/div>';
var totalC=0;COMPS.forEach(function(c,ci){var pct=d.vt>0&&d.comps[c.domain]?Math.round(d.comps[c.domain]/d.vt*100):0;if(pct>0){h+='<div class="sov-seg" style="width:'+pct+'%;background:'+CC[ci%CC.length]+'">'+pct+'%<\/div>';totalC+=pct}});
var rest=Math.max(0,100-qPct-totalC);if(rest>0)h+='<div class="sov-seg" style="width:'+rest+'%;background:var(--surface3)"><\/div>';
h+='<\/div><div class="sov-total">'+fmt(d.vt)+'<\/div><\/div>'});
h+='<div style="display:flex;gap:8px;margin:5px 0 10px;font-size:.7rem;color:var(--text3)"><span>\u25a0 tu dominio<\/span>';COMPS.forEach(function(c,ci){h+='<span style="color:'+CC[ci%CC.length]+'">\u25a0 '+c.domain.split('.')[0]+'<\/span>'});h+='<span>\u25a0 otros<\/span><\/div>';
el.innerHTML=h}

function classifyCluster(kw){var k=(kw||'').toLowerCase();if(/limpiafondos|robot|dolphin|zodiac|wybot|beatbot/.test(k))return 'Robots';if(/depuradora|filtro|arena|vidrio/.test(k))return 'Filtros';if(/cloro|ph|algas|floculante|bromo|quimic/.test(k))return 'Qu\u00edmicos';if(/cubierta|cobertor|invern|lona/.test(k))return 'Cubiertas';if(/recambio|repuesto|parts|despiece|bomba dosificadora|seko|tekna/.test(k))return 'Recambios';if(/desmontable|intex|gre|tubular/.test(k))return 'Desmontables';if(/escalera|valla|ducha|gresite/.test(k))return 'Accesorios';if(/clorador salino|innowater/.test(k))return 'Cloraci\u00f3n';return 'Otros'}

function toggleDetail(domain){var area=document.getElementById('compDetailArea');if(!area)return;if(expandedComp===domain){expandedComp=null;area.innerHTML='';return}expandedComp=domain;
var ci=COMPS.findIndex(function(c){return c.domain===domain});var col=CC[ci%CC.length];var shared=COMP_SHARED[domain]||[];var gapKws=COMP_GAPS[domain]||[];var dn=domain.split('.')[0];
var wins=shared.filter(function(s){return s.posQ>0&&s.posQ<=s.posC}).length;var losses=shared.filter(function(s){return s.posQ>s.posC||s.posQ===0}).length;var bvol=shared.reduce(function(s,x){return s+x.vol},0);var gvol=gapKws.reduce(function(s,x){return s+x.vol},0);
var h='<div style="border:1px solid '+col+';border-left:3px solid '+col+';border-radius:8px;padding:12px;margin-top:8px">';
h+='<div style="font-weight:600;margin-bottom:8px">'+domain+' vs tu dominio<\/div>';
if(shared.length){h+='<div style="font-weight:600;color:var(--text2);margin-bottom:6px">Win / Loss<\/div><div class="wl-grid"><div class="wl-box"><div class="wl-v" style="color:var(--success)">'+wins+'<\/div><div class="wl-l">Ganas t\u00fa<\/div><\/div><div class="wl-box"><div class="wl-v" style="color:#dc2626">'+losses+'<\/div><div class="wl-l">Gana '+dn+'<\/div><\/div><div class="wl-box"><div class="wl-v">'+fmt(bvol)+'<\/div><div class="wl-l">Vol. disputado<\/div><\/div><\/div>';
h+='<table class="kw-table"><tr><th style="text-align:left">KW<\/th><th style="text-align:right">Vol<\/th><th style="text-align:right">T\u00fa<\/th><th style="text-align:right">'+dn+'<\/th><\/tr>';
shared.sort(function(a,b){return b.vol-a.vol}).slice(0,10).forEach(function(s){var w=s.posQ>0&&s.posQ<=s.posC;h+='<tr><td >'+s.kw+'<\/td><td style="text-align:right;font-family:var(--mono)">'+s.vol.toLocaleString()+'<\/td><td style="text-align:right;font-family:var(--mono);color:'+(w?'var(--success)':'var(--danger)')+'">'+(s.posQ||'\u2014')+'<\/td><td style="text-align:right;font-family:var(--mono);color:'+(w?'var(--danger)':'var(--success)')+'">'+s.posC+'<\/td><\/tr>'});h+='<\/table>'}
if(gapKws.length){h+='<div style="font-weight:600;color:var(--text2);margin-bottom:6px;margin-top:8px">Gap exclusivo ('+fmt(gvol)+'/mes)<\/div><div class="kw-table-wrap"><table class="kw-table"><thead><tr><th>Keyword<\/th><th style="text-align:right">Vol.<\/th><\/tr><\/thead><tbody>';gapKws.sort(function(a,b){return b.vol-a.vol}).slice(0,10).forEach(function(g){h+='<tr><td>'+g.kw+'<\/td><td style="text-align:right;font-family:var(--mono);font-weight:600">'+g.vol.toLocaleString()+'<\/td><\/tr>'});h+='<\/tbody><\/table><\/div>'}
h+='<\/div>';area.innerHTML=h}

function tog(id,btn){var el=document.getElementById(id);if(!el)return;var o=el.classList.toggle('open');btn.innerHTML=o?'\u2630 Ocultar':'\u2630 Insight'}
function buildFilters(){var af=document.getElementById('archFilters');af.innerHTML=ARCHS.map(function(a){return '<button class="fbtn active" data-arch="'+a.id+'" style="border-color:'+a.color+'">'+a.icon+' '+a.name+'<\/button>'}).join('');af.querySelectorAll('.fbtn').forEach(function(b){b.addEventListener('click',function(){b.classList.toggle('active');var v=b.dataset.arch;if(aA.has(v))aA.delete(v);else aA.add(v);updateAll()})});
var pf=document.getElementById('phaseFilters');pf.innerHTML=['all'].concat(PH).map(function(p){return '<button class="fbtn'+(p==='all'?' active':'')+'" data-phase="'+p+'">'+(p==='all'?'Todas':p.substring(0,6))+'<\/button>'}).join('');pf.querySelectorAll('.fbtn').forEach(function(b){b.addEventListener('click',function(){pf.querySelectorAll('.fbtn').forEach(function(x){x.classList.remove('active')});b.classList.add('active');aP=b.dataset.phase;updateAll()})})}
document.addEventListener('DOMContentLoaded',function(){buildFilters();initCharts();updateAll();document.getElementById('kwSearch').addEventListener('input',function(e){sT=e.target.value;updateAll()});document.querySelector('#kwTable thead').addEventListener('click',function(e){var th=e.target.closest('th');if(!th)return;var c=th.dataset.col;if(sC===c)sD*=-1;else{sC=c;sD=['kw','intent','phase'].indexOf(c)!==-1?1:-1}updateAll()})});
<\/script></body></html>`;
}
