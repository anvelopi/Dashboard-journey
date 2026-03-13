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

    // Classify all keywords locally (instant)
    const classified = keywords.map((k: any) => ({
      ...k,
      phase: getPhase(k.kw, k.pos),
      intent: getIntent(k.kw),
      archs: getArchs(k.kw),
      cluster: getCluster(k.kw),
    }));

    // Build cluster summary for Claude
    const clusters: Record<string, any[]> = {};
    classified.forEach((k: any) => {
      if (!clusters[k.cluster]) clusters[k.cluster] = [];
      clusters[k.cluster].push(k);
    });

    let clusterCtx = "";
    Object.entries(clusters)
      .sort((a, b) => b[1].reduce((s: number, k: any) => s + k.imp, 0) - a[1].reduce((s: number, k: any) => s + k.imp, 0))
      .forEach(([name, items]) => {
        const imp = items.reduce((s: number, k: any) => s + k.imp, 0);
        const clicks = items.reduce((s: number, k: any) => s + k.clicks, 0);
        const avgPos = +(items.reduce((s: number, k: any) => s + k.pos, 0) / items.length).toFixed(1);
        const top3 = [...items].sort((a, b) => b.imp - a.imp).slice(0, 3).map((k: any) => `"${k.kw}" ${k.imp}imp pos.${k.pos}`).join(", ");
        clusterCtx += `${name}: ${items.length}kws, ${imp}imp, ${clicks}clicks, pos.${avgPos}. Top: ${top3}\n`;
      });

    const totalClicks = classified.reduce((s: number, k: any) => s + k.clicks, 0);
    const totalImp = classified.reduce((s: number, k: any) => s + k.imp, 0);

    const topPages = pages.slice(0, 10).map((p: any) => `${p.page} ses:${p.sessions} rev:${p.revenue}`).join("\n");

    const prompt = `Dominio: ${domain}
${classified.length} keywords, ${totalClicks} clicks, ${totalImp} impresiones (28d)
Revenue 30d: ${revenue.total || 0} EUR, ${revenue.transactions || 0} transacciones

CLUSTERS:
${clusterCtx}
TOP PAGINAS GA4:
${topPages}

Genera JSON con: archetypes (4, basados en clusters reales), pain_points (8, frases del usuario), insights (4 arquetipos x 6 fases), content_gaps (10), recommendations (6).`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        system: PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Anthropic:", res.status, err.slice(0, 200));
      return NextResponse.json({ enabled: true, journey: { keywords_classified: classified } });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    let ai = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) ai = JSON.parse(m[0]);
    } catch { console.error("JSON parse failed"); }

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
    return NextResponse.json({ enabled: true, error: e.message, journey: { keywords_classified: [] } });
  }
}

// ═══ CLASSIFICATION ═══
function getPhase(kw: string, pos: number): string {
  const k = (kw || "").toLowerCase();
  if (/recambio|repuesto|manual|pieza|part|replacement|invern/.test(k)) return "Post-venta";
  if (/quimipool|quimpool|quimipol/.test(k)) return "Compra";
  if (/precio|cuanto|barato|oferta|comparar|opiniones/.test(k)) return "Evaluaci\u00f3n";
  if (/como |c\u00f3mo |que es|qu\u00e9 es|diferencia|mejor |cual |tutorial/.test(k)) return "Investigaci\u00f3n";
  if (/limpiafondos|clorador|depuradora|filtro|robot|cubierta|bomba|valla|escalera/.test(k)) return "Evaluaci\u00f3n";
  return "Descubrimiento";
}

function getIntent(kw: string): string {
  const k = (kw || "").toLowerCase();
  if (/quimipool|astralpool|espa |seko |zodiac /.test(k)) return "Navegacional";
  if (/comprar|precio|barato|oferta/.test(k)) return "Transaccional";
  if (/como |c\u00f3mo |que es|qu\u00e9 es|tutorial/.test(k)) return "Informacional";
  return "Comercial";
}

function getArchs(kw: string): string[] {
  const k = (kw || "").toLowerCase();
  if (/quimipool/.test(k)) return ["A1", "A2", "A3", "A4"];
  const a: string[] = [];
  if (/seko|tekna|dosificadora|fotometro|fot\u00f3metro|orp|kontrol|etatron|poollab|lovibond|hanna|turbidimetro/.test(k)) a.push("A4");
  if (/robot|dolphin|wybot|beatbot|zodiac|sin cable|clorador salino|cubierta.*auto|liberty|sora/.test(k)) a.push("A3");
  if (/recambio|repuesto|part|manual|despiece|diagram|ersatz|pi\u00e8ces/.test(k)) a.push("A2");
  if (/depuradora|mantenimiento|cloro|filtro piscina|como |c\u00f3mo |gresite|valla|escalera|desmontable|gre /.test(k)) a.push("A1");
  return a.length ? a : ["A1"];
}

function getCluster(kw: string): string {
  const k = (kw || "").toLowerCase();
  if (/limpiafondos|robot.*pisc|dolphin|zodiac|wybot|beatbot|aquabot|aquasense|sora|osprey|carrera|liberty|skimmi|navigator|tiger/.test(k)) return "Robots";
  if (/depuradora|filtro.*arena|filtro.*pisc|aster|star.*plus|vidrio.*filtrante|brio/.test(k)) return "Filtraci\u00f3n";
  if (/clorador|cloro|sal.*pisc|innowater|smc|idegis|bspool|ph.*pisc|regulador.*ph|dosificador|bomba.*dos|seko|tekna|kontrol|orp|redox/.test(k)) return "Tratamiento";
  if (/fotometro|fot\u00f3metro|poollab|aquachek|lovibond|hanna|turbidimetro|medidor|test.*agua/.test(k)) return "An\u00e1lisis";
  if (/cubierta|cobertor|invern|lona|manta.*termic/.test(k)) return "Cubiertas";
  if (/bomba.*pisc|bomba.*espa|espa.*silen|espa.*iris|kripsol|hayward|aquagem|presscontrol/.test(k)) return "Bombas";
  if (/valla.*pisc|pool.*alarm|alarma|recinzione/.test(k)) return "Seguridad";
  if (/gresite|escalera|bordadura|trampolim|duikplank|plato.*ducha|foco.*pisc|lumiplus|liner|sika/.test(k)) return "Accesorios";
  if (/desmontable|gre|intex|composite|tubular/.test(k)) return "Desmontables";
  if (/recambio|repuesto|part|pi\u00e8ces|ersatz|spare|replacement|\d{7,}/.test(k)) return "Recambios";
  if (/quimipool|astralpool|kripsol|poolex|fluidra/.test(k)) return "Marca";
  return "Otros";
}

function defaultArchs() {
  return [
    { id: "A1", name: "Preparador Temporada", icon: "\ud83c\udfca", desc: "Activa piscina abr-may. Depuradoras, filtros, qu\u00edmicos.", pct: 35, color: "#00b4d8" },
    { id: "A2", name: "Manitas Reparador", icon: "\ud83d\udd27", desc: "Recambios exactos por referencia. Compra recurrente.", pct: 25, color: "#0d6e5b" },
    { id: "A3", name: "Automatizador", icon: "\u26a1", desc: "Robots sin cable, cloradores salinos. Ticket alto.", pct: 25, color: "#d97706" },
    { id: "A4", name: "T\u00e9cnico Pro", icon: "\ud83c\udfd7\ufe0f", desc: "Bombas dosificadoras, fot\u00f3metros. B2B.", pct: 15, color: "#7c3aed" },
  ];
}

const PROMPT = `Eres consultor SEO de e-commerce de piscinas en Espa\u00f1a. Devuelve SOLO JSON:

{
  "archetypes": [
    {"id":"A1","name":"nombre especifico","icon":"emoji","desc":"2 frases basadas en clusters reales","pct":35,"color":"#00b4d8"},
    {"id":"A2","name":"...","icon":"...","desc":"...","pct":25,"color":"#0d6e5b"},
    {"id":"A3","name":"...","icon":"...","desc":"...","pct":25,"color":"#d97706"},
    {"id":"A4","name":"...","icon":"...","desc":"...","pct":15,"color":"#7c3aed"}
  ],
  "pain_points": [
    {"title":"frase del USUARIO","desc":"con datos reales","phases":["Fase"],"archs":["A1"],"sev":5}
  ],
  "insights": {
    "A1": {
      "Descubrimiento":{"t":"piensa","f":"siente","p":["pain"],"g":["gain"]},
      "Investigaci\u00f3n":{"t":"...","f":"...","p":["..."],"g":["..."]},
      "Evaluaci\u00f3n":{"t":"...","f":"...","p":["..."],"g":["..."]},
      "Decisi\u00f3n":{"t":"...","f":"...","p":["..."],"g":["..."]},
      "Compra":{"t":"...","f":"...","p":["..."],"g":["..."]},
      "Post-venta":{"t":"...","f":"...","p":["..."],"g":["..."]}
    },
    "A2":{...6 fases...},"A3":{...6 fases...},"A4":{...6 fases...}
  },
  "content_gaps": [
    {"arch":"A1","phase":"Descubrimiento","title":"titulo","kws":"keywords","prio":"alta"}
  ],
  "recommendations": [
    {"title":"accion","priority":"ALTA","phase":"Fase","type":"SEO","impact":"impacto","effort":"2h","description":"descripcion"}
  ]
}

REGLAS: Arquetipos basados en clusters reales. Pain points como frases del usuario. Fases EXACTAS: Descubrimiento, Investigaci\u00f3n, Evaluaci\u00f3n, Decisi\u00f3n, Compra, Post-venta. Solo JSON.`;
