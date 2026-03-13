export const maxDuration = 60;

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ enabled: !!process.env.ANTHROPIC_API_KEY });
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ enabled: false });
  }

  try {
    const body = await req.json();
    const { keywords = [], pages = [], revenue = {}, domain = "" } = body;

    // ═══ CLASSIFY ALL KEYWORDS LOCALLY ═══
    const classified = keywords.map((k: any) => ({
      ...k,
      phase: getPhase(k.kw, k.pos),
      intent: getIntent(k.kw),
      archs: getArchs(k.kw),
      cluster: getCluster(k.kw),
    }));

    // ═══ BUILD CLUSTER AGGREGATION ═══
    const clusterMap: Record<string, any[]> = {};
    classified.forEach((k: any) => {
      if (!clusterMap[k.cluster]) clusterMap[k.cluster] = [];
      clusterMap[k.cluster].push(k);
    });

    const sortedClusters = Object.entries(clusterMap)
      .map(([name, items]) => {
        const imp = items.reduce((s: number, k: any) => s + k.imp, 0);
        const clicks = items.reduce((s: number, k: any) => s + k.clicks, 0);
        const avgPos = +(items.reduce((s: number, k: any) => s + k.pos, 0) / items.length).toFixed(1);
        const avgCtr = imp > 0 ? +(clicks / imp * 100).toFixed(2) : 0;
        const sorted = [...items].sort((a, b) => b.imp - a.imp);
        const top5 = sorted.slice(0, 5).map((k: any) => `"${k.kw}" (${k.imp}imp, pos.${k.pos.toFixed(1)})`);
        const weak = sorted.filter((k: any) => k.imp > 100 && k.pos > 15).slice(0, 3);
        return { name, count: items.length, imp, clicks, avgPos, avgCtr, top5, weak };
      })
      .sort((a, b) => b.imp - a.imp);

    // ═══ BUILD COMPACT CONTEXT ═══
    const totalClicks = classified.reduce((s: number, k: any) => s + k.clicks, 0);
    const totalImp = classified.reduce((s: number, k: any) => s + k.imp, 0);

    let ctx = `DOMINIO: ${domain}\n${classified.length} keywords, ${totalClicks} clicks, ${totalImp} impresiones (28d)\n`;
    if (revenue.total) ctx += `Revenue: EUR${revenue.total}, ${revenue.transactions} transacciones\n`;
    ctx += `\nCLUSTERS:\n`;
    sortedClusters.slice(0, 10).forEach(cl => {
      ctx += `${cl.name}: ${cl.count}kws, ${cl.imp}imp, ${cl.clicks}cl, pos.${cl.avgPos}, CTR ${cl.avgCtr}%\n`;
      ctx += `  Top: ${cl.top5.slice(0, 3).join(", ")}\n`;
      if (cl.weak.length) ctx += `  Oportunidad: ${cl.weak.map((k: any) => `"${k.kw}" pos.${k.pos.toFixed(1)} ${k.imp}imp`).join(", ")}\n`;
    });

    if (pages.length) {
      ctx += `\nTOP PAGINAS: ${pages.slice(0, 8).map((p: any) => `${p.page} ses:${p.sessions} rev:${p.revenue}`).join(" | ")}\n`;
    }

    ctx += `\nGenera el JSON.`;

    // ═══ CALL SONNET (reduced output - no insight cells) ═══
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        system: PROMPT,
        messages: [{ role: "user", content: ctx }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Anthropic:", res.status, err.slice(0, 200));
      return NextResponse.json({ enabled: true, journey: buildFallback(classified, domain) });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    let ai = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) ai = JSON.parse(m[0]);
    } catch { console.error("JSON parse failed, length:", text.length); }

    // ═══ BUILD INSIGHTS LOCALLY (fast, no API) ═══
    const archIds = (ai?.archetypes || defaultArchs()).map((a: any) => a.id);
    const insights = buildInsightsLocally(classified, clusterMap, archIds);

    return NextResponse.json({
      enabled: true,
      journey: {
        keywords_classified: classified,
        archetypes: ai?.archetypes || defaultArchs(),
        pain_points: ai?.pain_points || [],
        insights,
        content_gaps: ai?.content_gaps || [],
        recommendations: ai?.recommendations || [],
      },
    });
  } catch (e: any) {
    console.error("Insights error:", e.message);
    return NextResponse.json({ enabled: true, error: e.message, journey: { keywords_classified: [], archetypes: defaultArchs(), pain_points: [], insights: {}, content_gaps: [], recommendations: [] } });
  }
}

// ═══ BUILD INSIGHTS LOCALLY FROM CLUSTER DATA ═══
function buildInsightsLocally(kws: any[], clusterMap: Record<string, any[]>, archIds: string[]): Record<string, any> {
  const phases = ["Descubrimiento", "Investigación", "Evaluación", "Decisión", "Compra", "Post-venta"];
  const insights: Record<string, any> = {};

  const archDescMap: Record<string, { think: string; feel: string }> = {
    A1: { think: "Necesito equipar mi piscina para la temporada", feel: "Abrumado por tantas opciones" },
    A2: { think: "Necesito encontrar esta pieza exacta", feel: "Frustrado si no la encuentro rápido" },
    A3: { think: "Quiero automatizar el mantenimiento", feel: "Dispuesto a invertir si merece la pena" },
    A4: { think: "Necesito equipos técnicos profesionales", feel: "Busco fiabilidad y soporte técnico" },
  };

  const phaseThink: Record<string, string> = {
    "Descubrimiento": "Empieza a buscar información general",
    "Investigación": "Compara opciones y lee sobre tecnologías",
    "Evaluación": "Compara precios y modelos concretos",
    "Decisión": "Ya sabe lo que quiere, busca la mejor oferta",
    "Compra": "Busca la tienda directamente para comprar",
    "Post-venta": "Necesita soporte, recambios o mantenimiento",
  };

  archIds.forEach(archId => {
    insights[archId] = {};
    const archKws = kws.filter((k: any) => k.archs && k.archs.includes(archId));
    const archBase = archDescMap[archId] || { think: "Busca productos", feel: "Necesita orientación" };

    phases.forEach(phase => {
      const phaseKws = archKws.filter((k: any) => k.phase === phase);
      const topKw = phaseKws.length > 0
        ? [...phaseKws].sort((a, b) => b.imp - a.imp)[0]
        : null;

      const totalImp = phaseKws.reduce((s: number, k: any) => s + k.imp, 0);
      const avgPos = phaseKws.length
        ? +(phaseKws.reduce((s: number, k: any) => s + k.pos, 0) / phaseKws.length).toFixed(1)
        : 0;

      const pains: string[] = [];
      const gains: string[] = [];

      if (phaseKws.length === 0) {
        pains.push("Sin presencia en esta fase del journey");
        gains.push("Oportunidad de crear contenido para esta fase");
      } else {
        if (avgPos > 20) pains.push(`Posición media ${avgPos} — muy baja visibilidad`);
        else if (avgPos > 10) pains.push(`Posición media ${avgPos} — fuera de primera página`);

        const lowCtr = phaseKws.filter((k: any) => k.imp > 100 && k.ctr < 2);
        if (lowCtr.length > 0) pains.push(`${lowCtr.length} keywords con CTR < 2% pese a impresiones`);

        if (topKw && topKw.pos <= 5) gains.push(`"${topKw.kw}" en pos.${topKw.pos} — mantener`);
        if (totalImp > 1000) gains.push(`${totalImp.toLocaleString()} impresiones/mes en esta fase`);
        if (phaseKws.length > 5) gains.push(`${phaseKws.length} keywords activas — buena cobertura`);
      }

      if (pains.length === 0) pains.push("Sin problemas detectados en datos");
      if (gains.length === 0) gains.push("Potencial por explorar");

      insights[archId][phase] = {
        t: topKw ? `Busca "${topKw.kw}" y similares. ${phaseThink[phase]}.` : `${phaseThink[phase]}.`,
        f: archBase.feel,
        p: pains,
        g: gains,
      };
    });
  });

  return insights;
}

// ═══ CLASSIFICATION ═══
function getPhase(kw: string, pos: number): string {
  const k = (kw || "").toLowerCase();
  if (/recambio|repuesto|manual|pieza|part|replacement|invern/.test(k)) return "Post-venta";
  if (/quimipool|quimpool|quimipol/.test(k)) return "Compra";
  if (/precio|cuanto|cuánto|barato|oferta|comparar|opiniones/.test(k)) return "Evaluación";
  if (/como |cómo |que es|qué es|diferencia|mejor |cual |cuál |tutorial|guia|guía/.test(k)) return "Investigación";
  if (/limpiafondos|clorador|depuradora|filtro|robot|cubierta|bomba|valla|escalera|gresite/.test(k)) return "Evaluación";
  return "Descubrimiento";
}

function getIntent(kw: string): string {
  const k = (kw || "").toLowerCase();
  if (/quimipool|astralpool|espa |seko |zodiac |kripsol|poolex/.test(k)) return "Navegacional";
  if (/comprar|precio|barato|oferta|tienda/.test(k)) return "Transaccional";
  if (/mejor|comparar|comparativa|vs |opiniones|review|alternativa/.test(k)) return "Comercial";
  if (/como |cómo |que es|qué es|tutorial|guia|guía|diferencia/.test(k)) return "Informacional";
  return "Comercial";
}

function getArchs(kw: string): string[] {
  const k = (kw || "").toLowerCase();
  if (/quimipool/.test(k)) return ["A1", "A2", "A3", "A4"];
  const a: string[] = [];
  if (/seko|tekna|dosificadora|fotometro|fotómetro|orp|kontrol|etatron|poollab|lovibond|hanna|turbidimetro|cuadro.*electr/.test(k)) a.push("A4");
  if (/robot|dolphin|wybot|beatbot|zodiac|sin cable|clorador salino|cubierta.*auto|liberty|sora|aquasense/.test(k)) a.push("A3");
  if (/recambio|repuesto|part|manual|despiece|diagram|ersatz|pièces|spare|replacement|\d{7}/.test(k)) a.push("A2");
  if (/depuradora|mantenimiento|cloro|filtro piscina|como |cómo |gresite|valla|escalera|desmontable|gre |productos.*pisc/.test(k)) a.push("A1");
  return a.length ? a : ["A1"];
}

function getCluster(kw: string): string {
  const k = (kw || "").toLowerCase();
  if (/limpiafondos|robot.*pisc|dolphin|zodiac|wybot|beatbot|aquabot|aquasense|sora|osprey|carrera|liberty|skimmi|navigator|tiger/.test(k)) return "Robots y limpiafondos";
  if (/depuradora|filtro.*arena|filtro.*pisc|aster|star.*plus|vidrio.*filtrante|brio/.test(k)) return "Filtración y depuración";
  if (/clorador|cloro|sal.*pisc|innowater|smc|idegis|bspool|ph.*pisc|regulador.*ph|dosificador|bomba.*dos|seko|tekna|kontrol|orp|redox/.test(k)) return "Cloración y tratamiento";
  if (/fotometro|fotómetro|poollab|aquachek|lovibond|hanna|turbidimetro|medidor|test.*agua/.test(k)) return "Análisis de agua";
  if (/cubierta|cobertor|invern|lona|manta.*termic/.test(k)) return "Cubiertas e invernaje";
  if (/bomba.*pisc|bomba.*espa|espa.*silen|espa.*iris|kripsol|hayward|aquagem|presscontrol/.test(k)) return "Bombas y motores";
  if (/valla.*pisc|pool.*alarm|alarma|recinzione|pool.*zaun/.test(k)) return "Vallas y seguridad";
  if (/gresite|escalera|bordadura|trampolim|duikplank|plato.*ducha|foco.*pisc|lumiplus|liner|sika/.test(k)) return "Accesorios";
  if (/desmontable|gre|intex|composite|tubular|pvc.*pisc|acero/.test(k)) return "Piscinas desmontables";
  if (/recambio|repuesto|part|pièces|ersatz|spare|replacement|\d{7,}/.test(k)) return "Recambios";
  if (/quimipool|astralpool|kripsol|poolex|fluidra|qp/.test(k)) return "Marca";
  return "Otros";
}

function defaultArchs() {
  return [
    { id: "A1", name: "El Preparador de Temporada", icon: "🏊", desc: "Propietario que activa su piscina en abril-mayo. Busca depuradoras, filtros, químicos básicos. Ticket €200-600.", pct: 35, color: "#00b4d8" },
    { id: "A2", name: "El Manitas Reparador", icon: "🔧", desc: "Veterano que busca recambios exactos por referencia y despieces. Compra recurrente. Ticket €30-150.", pct: 25, color: "#0d6e5b" },
    { id: "A3", name: "El Automatizador Premium", icon: "⚡", desc: "Quiere robots sin cable, cloradores salinos, cubiertas automáticas. Investiga mucho. Ticket €400-1.200.", pct: 25, color: "#d97706" },
    { id: "A4", name: "El Técnico Profesional", icon: "🏗️", desc: "Instalador o piscinero. Bombas dosificadoras Seko, fotómetros Hanna/Lovibond. B2B.", pct: 15, color: "#7c3aed" },
  ];
}

function buildFallback(classified: any[], domain: string) {
  return {
    keywords_classified: classified,
    archetypes: defaultArchs(),
    pain_points: [],
    insights: buildInsightsLocally(classified, {}, ["A1", "A2", "A3", "A4"]),
    content_gaps: [],
    recommendations: [],
  };
}

const PROMPT = `Eres consultor SEO de e-commerce de piscinas en España. Analiza los clusters de búsqueda reales y devuelve SOLO JSON válido (sin texto, sin backticks):

{
  "archetypes": [
    {"id":"A1","name":"nombre MUY específico basado en clusters","icon":"emoji","desc":"2-3 frases: qué busca, cuándo, ticket, comportamiento. BASADO EN LOS DATOS.","pct":35,"color":"#00b4d8"},
    {"id":"A2","name":"...","icon":"...","desc":"...","pct":25,"color":"#0d6e5b"},
    {"id":"A3","name":"...","icon":"...","desc":"...","pct":25,"color":"#d97706"},
    {"id":"A4","name":"...","icon":"...","desc":"...","pct":15,"color":"#7c3aed"}
  ],
  "pain_points": [
    {"title":"frase del USUARIO no del SEO","desc":"datos reales del cluster","phases":["Evaluación"],"archs":["A1"],"sev":5}
  ],
  "content_gaps": [
    {"arch":"A1","phase":"Evaluación","title":"título","kws":"keywords","prio":"alta"}
  ],
  "recommendations": [
    {"title":"acción concreta","priority":"ALTA","phase":"Evaluación","type":"SEO","impact":"impacto EUR","effort":"2h","description":"1-2 frases accionables"}
  ]
}

REGLAS: Arquetipos del sector piscinas basados en clusters reales. 8-10 pain points como frases del usuario (ej: "No sé qué depuradora necesito"). 10 content gaps. 6 recomendaciones con impacto. Solo JSON.`;
