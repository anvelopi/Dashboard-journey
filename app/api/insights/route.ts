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
    const clusters: Record<string, any[]> = {};
    classified.forEach((k: any) => {
      if (!clusters[k.cluster]) clusters[k.cluster] = [];
      clusters[k.cluster].push(k);
    });

    const sortedClusters = Object.entries(clusters)
      .map(([name, items]) => {
        const imp = items.reduce((s: number, k: any) => s + k.imp, 0);
        const clicks = items.reduce((s: number, k: any) => s + k.clicks, 0);
        const avgPos = +(items.reduce((s: number, k: any) => s + k.pos, 0) / items.length).toFixed(1);
        const avgCtr = imp > 0 ? +(clicks / imp * 100).toFixed(2) : 0;
        const sorted = [...items].sort((a, b) => b.imp - a.imp);
        const top5 = sorted.slice(0, 5).map((k: any) => `"${k.kw}" (${k.imp}imp, pos.${k.pos.toFixed(1)}, ${k.clicks}cl)`);
        const weak = sorted.filter((k: any) => k.imp > 100 && k.pos > 15).slice(0, 3).map((k: any) => `"${k.kw}" pos.${k.pos.toFixed(1)} con ${k.imp}imp`);
        const phases: Record<string, number> = {};
        items.forEach((k: any) => { phases[k.phase] = (phases[k.phase] || 0) + k.clicks; });
        return { name, count: items.length, imp, clicks, avgPos, avgCtr, top5, weak, phases };
      })
      .sort((a, b) => b.imp - a.imp);

    // ═══ BUILD PHASE SUMMARY ═══
    const phaseSums: Record<string, { count: number; clicks: number; imp: number; avgPos: number }> = {};
    classified.forEach((k: any) => {
      if (!phaseSums[k.phase]) phaseSums[k.phase] = { count: 0, clicks: 0, imp: 0, avgPos: 0 };
      phaseSums[k.phase].count++;
      phaseSums[k.phase].clicks += k.clicks;
      phaseSums[k.phase].imp += k.imp;
      phaseSums[k.phase].avgPos += k.pos;
    });
    Object.values(phaseSums).forEach((p: any) => { if (p.count) p.avgPos = +(p.avgPos / p.count).toFixed(1); });

    // ═══ BUILD PATTERNS ═══
    const intlCount = classified.filter((k: any) => /pièces|ersatz|onderdelen|duikplank|glijbaan|zwembad|pompe|recinzione|copertura|couverture|boia|escada|pedra|piscine/.test(k.kw)).length;
    const refCount = classified.filter((k: any) => /^\d{5,}|^[a-z]{2,3}\d{3,}|\d{7}/.test(k.kw)).length;
    const problemCount = classified.filter((k: any) => /como |cómo |pierde agua|no arranca|eliminar algas|limpiar filtro|cambiar arena|que es el/.test(k.kw)).length;
    const brandKws = classified.filter((k: any) => /quimipool|quimpool|quimipol/.test(k.kw));
    const brandClicks = brandKws.reduce((s: number, k: any) => s + k.clicks, 0);

    const totalClicks = classified.reduce((s: number, k: any) => s + k.clicks, 0);
    const totalImp = classified.reduce((s: number, k: any) => s + k.imp, 0);

    // ═══ BUILD RICH CONTEXT ═══
    let ctx = `DOMINIO: ${domain}
TOTAL: ${classified.length} keywords, ${totalClicks.toLocaleString()} clicks, ${totalImp.toLocaleString()} impresiones (28d)
REVENUE 30d: EUR${revenue.total || 0}, ${revenue.transactions || 0} transacciones, ${revenue.sessions || 0} sesiones
SECTOR: tienda online de piscinas en España

=== CLUSTERS SEMANTICOS ===
`;
    sortedClusters.forEach(cl => {
      ctx += `\n▸ ${cl.name}: ${cl.count}kws, ${cl.imp.toLocaleString()}imp, ${cl.clicks}cl, pos.${cl.avgPos}, CTR ${cl.avgCtr}%\n`;
      ctx += `  Top: ${cl.top5.join(" | ")}\n`;
      if (cl.weak.length) ctx += `  ⚠ Oportunidad: ${cl.weak.join(" | ")}\n`;
      ctx += `  Fases: ${Object.entries(cl.phases).map(([p, c]) => `${p}:${c}cl`).join(", ")}\n`;
    });

    ctx += `\n=== DISTRIBUCION POR FASE ===\n`;
    Object.entries(phaseSums).forEach(([p, d]) => {
      ctx += `${p}: ${d.count}kws, ${d.clicks}cl, ${d.imp.toLocaleString()}imp, pos.${d.avgPos}\n`;
    });

    if (pages.length) {
      ctx += `\n=== TOP PAGINAS GA4 ===\n`;
      pages.slice(0, 12).forEach((p: any) => {
        ctx += `${p.page} | ses:${p.sessions} rev:EUR${p.revenue}\n`;
      });
    }

    ctx += `\n=== PATRONES ===\n`;
    if (intlCount) ctx += `- ${intlCount} busquedas internacionales (FR, DE, NL, PT, IT)\n`;
    if (refCount) ctx += `- ${refCount} busquedas por referencia/SKU exacta (usuarios expertos)\n`;
    if (problemCount) ctx += `- ${problemCount} busquedas de problemas/soluciones\n`;
    ctx += `- ${brandKws.length} busquedas marca (${brandClicks}cl) vs ${classified.length - brandKws.length} genericas (${totalClicks - brandClicks}cl)\n`;

    ctx += `\nGenera el JSON basandote en estos datos reales.`;

    // ═══ CALL CLAUDE SONNET ═══
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 6000,
        system: PROMPT,
        messages: [{ role: "user", content: ctx }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Anthropic:", res.status, err.slice(0, 300));
      return NextResponse.json({ enabled: true, journey: { keywords_classified: classified, archetypes: defaultArchs(), pain_points: [], insights: {}, content_gaps: [], recommendations: [] } });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    let ai = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) ai = JSON.parse(m[0]);
    } catch (e) {
      console.error("JSON parse failed, text length:", text.length);
    }

    return NextResponse.json({
      enabled: true,
      journey: {
        keywords_classified: classified,
        archetypes: ai?.archetypes || defaultArchs(),
        pain_points: ai?.pain_points || [],
        insights: ai?.insights || {},
        content_gaps: ai?.content_gaps || [],
        recommendations: ai?.recommendations || [],
      },
    });
  } catch (e: any) {
    console.error("Insights error:", e.message);
    return NextResponse.json({ enabled: true, error: e.message, journey: { keywords_classified: [], archetypes: defaultArchs(), pain_points: [], insights: {}, content_gaps: [], recommendations: [] } });
  }
}

// ═══ CLASSIFICATION FUNCTIONS ═══
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
    { id: "A1", name: "El Preparador de Temporada", icon: "🏊", desc: "Propietario que activa su piscina en abril-mayo. Busca depuradoras, filtros, químicos básicos. Ticket €200-600. Necesita guías y packs por m³.", pct: 35, color: "#00b4d8" },
    { id: "A2", name: "El Manitas Reparador", icon: "🔧", desc: "Veterano que busca recambios exactos por referencia y despieces. Compra recurrente de piezas Astralpool, ESPA, Seko. Ticket bajo €30-150.", pct: 25, color: "#0d6e5b" },
    { id: "A3", name: "El Automatizador Premium", icon: "⚡", desc: "Quiere robots sin cable (Dolphin, Wybot, Beatbot), cloradores salinos Innowater, cubiertas automáticas. Investiga mucho. Ticket alto €400-1.200.", pct: 25, color: "#d97706" },
    { id: "A4", name: "El Técnico Profesional", icon: "🏗️", desc: "Instalador o piscinero. Bombas dosificadoras Seko, fotómetros Hanna/Lovibond, controladores ORP. Compra técnica B2B.", pct: 15, color: "#7c3aed" },
  ];
}

const PROMPT = `Eres un consultor SEO senior especializado en e-commerce de piscinas. Analizas datos REALES de Search Console y Analytics.

Devuelve SOLO un JSON válido (sin texto, sin backticks, sin explicación):

{
  "archetypes": [
    {"id":"A1","name":"nombre MUY específico del sector piscinas","icon":"emoji","desc":"2-3 frases específicas: qué busca exactamente, en qué época, ticket medio, comportamiento de compra. Basado en los CLUSTERS REALES que ves en los datos.","pct":35,"color":"#00b4d8"},
    {"id":"A2","name":"...","icon":"...","desc":"...","pct":25,"color":"#0d6e5b"},
    {"id":"A3","name":"...","icon":"...","desc":"...","pct":25,"color":"#d97706"},
    {"id":"A4","name":"...","icon":"...","desc":"...","pct":15,"color":"#7c3aed"}
  ],
  "pain_points": [
    {"title":"frase que diría el USUARIO, NO el SEO","desc":"1-2 frases con datos reales: posiciones, impresiones, CTR del cluster","phases":["Evaluación"],"archs":["A1"],"sev":5}
  ],
  "insights": {
    "A1": {
      "Descubrimiento":{"t":"qué busca/piensa","f":"cómo se siente","p":["pain concreto"],"g":["oportunidad para la tienda"]},
      "Investigación":{"t":"...","f":"...","p":["..."],"g":["..."]},
      "Evaluación":{"t":"...","f":"...","p":["..."],"g":["..."]},
      "Decisión":{"t":"...","f":"...","p":["..."],"g":["..."]},
      "Compra":{"t":"...","f":"...","p":["..."],"g":["..."]},
      "Post-venta":{"t":"...","f":"...","p":["..."],"g":["..."]}
    },
    "A2":{...las 6 fases...},
    "A3":{...las 6 fases...},
    "A4":{...las 6 fases...}
  },
  "content_gaps": [
    {"arch":"A1","phase":"Evaluación","title":"título descriptivo","kws":"keywords relevantes","prio":"alta"}
  ],
  "recommendations": [
    {"title":"acción concreta y específica","priority":"ALTA","phase":"Evaluación","type":"CONTENIDO","impact":"estimación en EUR/mes o clicks","effort":"2-4h","description":"1-2 frases accionables con URLs y keywords específicas del dominio"}
  ]
}

REGLAS:
1. ARQUETIPOS: Deben reflejar los clusters de búsqueda reales. Si ves un cluster gordo de robots/limpiafondos, un arquetipo debe ser ese usuario. Nombres específicos del sector piscinas, NO genéricos.
2. PAIN POINTS (8-10): Frases del USUARIO. Mal: "Posición 93 para limpiafondos". Bien: "Quiero un robot pero no sé cuál elegir entre Dolphin, Zodiac y Wybot". Usa CTR bajo + muchas impresiones = frustración.
3. INSIGHTS: 1 frase CONCISA por campo (t, f, p, g). 4 arquetipos × 6 fases = 24 celdas. Sé breve.
4. CONTENT GAPS (10-15): Oportunidades reales basadas en keywords con pos>15 y muchas impresiones.
5. RECOMENDACIONES (6-8): Accionables con impacto en EUR si posible. Ordenadas por impacto.
6. Fases EXACTAS: Descubrimiento, Investigación, Evaluación, Decisión, Compra, Post-venta.
7. Solo JSON válido. Nada más.`;
