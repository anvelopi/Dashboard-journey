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

    const classified = keywords.map((k: any) => ({
      ...k,
      phase: getPhase(k.kw, k.pos),
      intent: getIntent(k.kw),
      archs: getArchs(k.kw),
      cluster: getCluster(k.kw),
    }));

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
        const top3 = [...items].sort((a, b) => b.imp - a.imp).slice(0, 3).map((k: any) => `"${k.kw}" ${k.imp}imp pos.${k.pos.toFixed(1)}`);
        return { name, count: items.length, imp, clicks, avgPos, top3 };
      })
      .sort((a, b) => b.imp - a.imp)
      .slice(0, 10);

    const totalC = classified.reduce((s: number, k: any) => s + k.clicks, 0);
    const totalI = classified.reduce((s: number, k: any) => s + k.imp, 0);

    let ctx = `${domain} | ${classified.length}kws ${totalC}clicks ${totalI}imp | Rev:${revenue.total||0}EUR ${revenue.transactions||0}tx\n\n`;
    sortedClusters.forEach(cl => {
      ctx += `${cl.name}: ${cl.count}kw ${cl.imp}imp ${cl.clicks}cl pos.${cl.avgPos} | ${cl.top3.join(", ")}\n`;
    });
    ctx += `\nTop pages: ${pages.slice(0, 5).map((p: any) => `${p.page} s:${p.sessions} r:${p.revenue}`).join(" | ")}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2500,
        system: PROMPT,
        messages: [{ role: "user", content: ctx }],
      }),
    });

    if (!res.ok) {
      console.error("Anthropic:", res.status);
      return NextResponse.json({ enabled: true, journey: fb(classified) });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    let ai: any = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) ai = JSON.parse(m[0]);
    } catch { /* parse failed */ }

    const archetypes = ai?.archetypes || defaultArchs();
    const insights = buildInsights(classified, archetypes.map((a: any) => a.id));

    return NextResponse.json({
      enabled: true,
      journey: {
        keywords_classified: classified,
        archetypes,
        pain_points: ai?.pain_points || [],
        insights,
        content_gaps: ai?.content_gaps || [],
        recommendations: ai?.recommendations || [],
      },
    });
  } catch (e: any) {
    console.error("Insights error:", e.message);
    return NextResponse.json({ enabled: true, journey: { keywords_classified: [], archetypes: defaultArchs(), pain_points: [], insights: {}, content_gaps: [], recommendations: [] } });
  }
}

function buildInsights(kws: any[], archIds: string[]) {
  const PH = ["Descubrimiento", "Investigaci\u00f3n", "Evaluaci\u00f3n", "Decisi\u00f3n", "Compra", "Post-venta"];
  const archFeel: Record<string, string> = {
    A1: "Abrumado por tantas opciones, no sabe por d\u00f3nde empezar",
    A2: "Frustrado si no encuentra la pieza exacta r\u00e1pido",
    A3: "Dispuesto a invertir pero necesita estar seguro",
    A4: "Profesional, busca fiabilidad y rapidez",
  };
  const phaseFeel: Record<string, string> = {
    "Descubrimiento": "Empieza a buscar, a\u00fan no sabe qu\u00e9 necesita exactamente",
    "Investigaci\u00f3n": "Compara opciones y lee sobre tecnolog\u00edas y materiales",
    "Evaluaci\u00f3n": "Ya tiene candidatos, compara precios y modelos concretos",
    "Decisi\u00f3n": "Sabe lo que quiere, busca la mejor oferta y disponibilidad",
    "Compra": "Busca la tienda directamente para comprar",
    "Post-venta": "Necesita soporte, recambios o instrucciones de mantenimiento",
  };

  const ins: Record<string, any> = {};
  archIds.forEach(aid => {
    ins[aid] = {};
    const aKws = kws.filter((k: any) => k.archs?.includes(aid));
    PH.forEach(ph => {
      const pKws = aKws.filter((k: any) => k.phase === ph);
      const top = pKws.length ? [...pKws].sort((a, b) => b.imp - a.imp)[0] : null;
      const totalImp = pKws.reduce((s: number, k: any) => s + k.imp, 0);
      const avgPos = pKws.length ? +(pKws.reduce((s: number, k: any) => s + k.pos, 0) / pKws.length).toFixed(1) : 0;
      const pains: string[] = [];
      const gains: string[] = [];
      if (!pKws.length) {
        pains.push("Sin presencia en esta fase");
        gains.push("Oportunidad de crear contenido");
      } else {
        if (avgPos > 20) pains.push("Pos. media " + avgPos + " \u2014 baja visibilidad");
        else if (avgPos > 10) pains.push("Pos. media " + avgPos + " \u2014 fuera de p\u00e1gina 1");
        const lowCtr = pKws.filter((k: any) => k.imp > 100 && k.ctr < 2);
        if (lowCtr.length) pains.push(lowCtr.length + " kws con CTR < 2% y muchas impresiones");
        if (top && top.pos <= 5) gains.push("\"" + top.kw + "\" en pos." + top.pos);
        if (totalImp > 500) gains.push(totalImp.toLocaleString() + " imp/mes");
        if (pKws.length > 3) gains.push(pKws.length + " keywords activas");
      }
      if (!pains.length) pains.push("Sin problemas destacados");
      if (!gains.length) gains.push("Potencial por explorar");
      ins[aid][ph] = {
        t: top ? "Busca \"" + top.kw + "\". " + phaseFeel[ph] + "." : phaseFeel[ph] + ".",
        f: archFeel[aid] || "Necesita orientaci\u00f3n",
        p: pains,
        g: gains,
      };
    });
  });
  return ins;
}

function getPhase(kw: string, pos: number): string {
  const k = (kw || "").toLowerCase();
  if (/recambio|repuesto|manual|pieza|part|replacement|invern/.test(k)) return "Post-venta";
  if (/quimipool|quimpool|quimipol/.test(k)) return "Compra";
  if (/precio|cuanto|cu\u00e1nto|barato|oferta|comparar|opiniones/.test(k)) return "Evaluaci\u00f3n";
  if (/como |c\u00f3mo |que es|qu\u00e9 es|diferencia|mejor |cual |cu\u00e1l |tutorial|guia|gu\u00eda/.test(k)) return "Investigaci\u00f3n";
  if (/limpiafondos|clorador|depuradora|filtro|robot|cubierta|bomba|valla|escalera|gresite/.test(k)) return "Evaluaci\u00f3n";
  return "Descubrimiento";
}

function getIntent(kw: string): string {
  const k = (kw || "").toLowerCase();
  if (/quimipool|astralpool|espa |seko |zodiac |kripsol|poolex/.test(k)) return "Navegacional";
  if (/comprar|precio|barato|oferta|tienda/.test(k)) return "Transaccional";
  if (/mejor|comparar|comparativa|vs |opiniones|review|alternativa/.test(k)) return "Comercial";
  if (/como |c\u00f3mo |que es|qu\u00e9 es|tutorial|guia|gu\u00eda|diferencia/.test(k)) return "Informacional";
  return "Comercial";
}

function getArchs(kw: string): string[] {
  const k = (kw || "").toLowerCase();
  if (/quimipool/.test(k)) return ["A1", "A2", "A3", "A4"];
  const a: string[] = [];
  if (/seko|tekna|dosificadora|fotometro|fot\u00f3metro|orp|kontrol|etatron|poollab|lovibond|hanna|turbidimetro|cuadro.*electr/.test(k)) a.push("A4");
  if (/robot|dolphin|wybot|beatbot|zodiac|sin cable|clorador salino|cubierta.*auto|liberty|sora|aquasense/.test(k)) a.push("A3");
  if (/recambio|repuesto|part|manual|despiece|diagram|ersatz|pi\u00e8ces|spare|replacement|\d{7}/.test(k)) a.push("A2");
  if (/depuradora|mantenimiento|cloro|filtro piscina|como |c\u00f3mo |gresite|valla|escalera|desmontable|gre |productos.*pisc/.test(k)) a.push("A1");
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
  if (/valla.*pisc|pool.*alarm|alarma|recinzione|pool.*zaun/.test(k)) return "Seguridad";
  if (/gresite|escalera|bordadura|trampolim|duikplank|plato.*ducha|foco.*pisc|lumiplus|liner|sika/.test(k)) return "Accesorios";
  if (/desmontable|gre|intex|composite|tubular|pvc.*pisc|acero/.test(k)) return "Desmontables";
  if (/recambio|repuesto|part|pi\u00e8ces|ersatz|spare|replacement|\d{7,}/.test(k)) return "Recambios";
  if (/quimipool|astralpool|kripsol|poolex|fluidra|qp/.test(k)) return "Marca";
  return "Otros";
}

function defaultArchs() {
  return [
    { id: "A1", name: "El Preparador de Temporada", icon: "\ud83c\udfca", desc: "Propietario que activa su piscina en abril-mayo. Busca depuradoras, filtros, qu\u00edmicos b\u00e1sicos. Ticket \u20ac200-600.", pct: 35, color: "#00b4d8" },
    { id: "A2", name: "El Manitas Reparador", icon: "\ud83d\udd27", desc: "Busca recambios exactos por referencia y despieces. Compra recurrente. Ticket \u20ac30-150.", pct: 25, color: "#0d6e5b" },
    { id: "A3", name: "El Automatizador Premium", icon: "\u26a1", desc: "Robots sin cable, cloradores salinos, cubiertas autom\u00e1ticas. Ticket alto \u20ac400-1.200.", pct: 25, color: "#d97706" },
    { id: "A4", name: "El T\u00e9cnico Profesional", icon: "\ud83c\udfd7\ufe0f", desc: "Bombas dosificadoras Seko, fot\u00f3metros Hanna/Lovibond. B2B.", pct: 15, color: "#7c3aed" },
  ];
}

function fb(classified: any[]) {
  return {
    keywords_classified: classified,
    archetypes: defaultArchs(),
    pain_points: [],
    insights: buildInsights(classified, ["A1", "A2", "A3", "A4"]),
    content_gaps: [],
    recommendations: [],
  };
}

const PROMPT = `Eres consultor SEO de piscinas en Espa\u00f1a. Recibes clusters de b\u00fasqueda reales de Search Console. Devuelve SOLO JSON:

{
  "archetypes": [
    {"id":"A1","name":"nombre MUY espec\u00edfico del sector piscinas basado en los clusters","icon":"emoji","desc":"2-3 frases: qu\u00e9 busca, cu\u00e1ndo, ticket medio, comportamiento. BASADO EN DATOS REALES.","pct":35,"color":"#00b4d8"},
    {"id":"A2","name":"...","icon":"...","desc":"...","pct":25,"color":"#0d6e5b"},
    {"id":"A3","name":"...","icon":"...","desc":"...","pct":25,"color":"#d97706"},
    {"id":"A4","name":"...","icon":"...","desc":"...","pct":15,"color":"#7c3aed"}
  ],
  "pain_points": [
    {"title":"frase que dir\u00eda el USUARIO buscando en Google, NO jerga SEO","desc":"dato real del cluster: impresiones, posici\u00f3n, CTR","phases":["Evaluaci\u00f3n"],"archs":["A1"],"sev":5}
  ],
  "content_gaps": [
    {"arch":"A1","phase":"Evaluaci\u00f3n","title":"contenido que falta","kws":"keywords","prio":"alta"}
  ],
  "recommendations": [
    {"title":"acci\u00f3n concreta","priority":"ALTA","phase":"Evaluaci\u00f3n","type":"SEO","impact":"impacto estimado","effort":"2h","description":"qu\u00e9 hacer exactamente"}
  ]
}

REGLAS: Nombres de arquetipos del sector piscinas, NO gen\u00e9ricos. 8 pain points como frases de usuario. 8 content gaps. 5 recomendaciones. Solo JSON.`;
