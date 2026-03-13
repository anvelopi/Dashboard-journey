import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ enabled: false, message: "No API key" });
  }
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "No auth" }, { status: 401 });

  try {
    const body = await req.json();
    const { keywords, pages, revenue, domain } = body;

    // STEP 1: Classify ALL keywords locally (instant)
    const classified = classifyKeywords(keywords || []);

    // STEP 2: Aggregate into semantic clusters with real data
    const clusterSummary = buildClusterSummary(classified);
    const phaseSummary = buildPhaseSummary(classified);

    // STEP 3: Build rich context for Claude using aggregated data (not individual kws)
    const ctx = buildContext(clusterSummary, phaseSummary, classified, (pages || []).slice(0, 20), revenue, domain);

    // STEP 4: Call Claude for qualitative insights
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: ctx }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return NextResponse.json({ enabled: true, journey: { keywords_classified: classified }, error: "API " + response.status });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    let aiData = null;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) aiData = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error("JSON parse error:", e, "Raw text length:", text.length);
    }

    const journey = {
      archetypes: aiData?.archetypes || buildDefaultArchetypes(domain),
      keywords_classified: classified,
      pain_points: aiData?.pain_points || [],
      insights: aiData?.insights || {},
      content_gaps: aiData?.content_gaps || [],
      recommendations: aiData?.recommendations || [],
    };

    return NextResponse.json({ enabled: true, journey });
  } catch (err: any) {
    console.error("Insights error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ enabled: !!process.env.ANTHROPIC_API_KEY });
}

// ═══ SEMANTIC CLUSTER DETECTION ═══
const CLUSTER_RULES: [string, RegExp][] = [
  ["Robots y limpiafondos", /limpiafondos|robot.*pisc|dolphin|zodiac|wybot|beatbot|aquabot|aquasense|sora p|osprey|carrera|liberty|e\d0i?$|s\d00|m\d00|skimmi|navigator|tiger.?shark/],
  ["Filtracion y depuracion", /depuradora|filtro.*arena|filtro.*pisc|aster.?99|star.?plus|filtro.*600|arena.*filtro|cambiar.*arena|vidrio.*filtrante|brio\s?2000|filter/],
  ["Cloracion y tratamiento", /clorador|cloro|sal.*pisc|salt.*chlor|innowater|smc\s?\d|sugar.?valley|quicksalt|idegis|bspool|sel.?clear|ph.*pisc|regulador.*ph|dosificador.*cloro|bomba.*dosificadora|seko|tekna|kontrol|pooldose|etatron|orp|redox|floculante|bromo/],
  ["Quimica y analisis agua", /fotometro|fotómetro|poollab|aquachek|lovibond|hanna|turbidimetro|medidor|analis|test.*agua|hi\d{3}|alcalinidad|calciumhypochlorit/],
  ["Cubiertas e invernaje", /cubierta|cobertor|invern|lona|abri.*pisc|copertura|couverture|thermal.*cover|manta.*termic/],
  ["Bombas y motores", /bomba.*pisc|bomba.*espa|espa.*silen|espa.*iris|espa.*tifon|kripsol|hayward.*power|saci|aquagem|inverpro|invereco|bomba.*agua|presscontrol|brio/],
  ["Vallas y seguridad", /valla.*pisc|pool.*alarm|recinzione|pool.*zaun|alarma.*pisc|pool.*fence|poolzaun/],
  ["Accesorios y construccion", /gresite|escalera.*pisc|bordadura|cenefa|boquilla|pasamanos|trampolim|duikplank|diving.*board|pool.*slide|escorrega|plato.*ducha|foco.*pisc|lumiplus|liner|sika/],
  ["Piscinas desmontables", /desmontable|piscina.*gre|piscina.*acero|piscina.*pvc|piscina.*composite|intex|tubular|elevada|acima.*solo|demontable/],
  ["Recambios y repuestos", /recambio|repuesto|part|pieza|pièces|ersatz|onderdelen|despiece|diagram|spare|replacement|diy$|\d{7,}/],
  ["Marcas y navegacion", /quimipool|quimpool|quimipol|astralpool|kripsol|poolex|aquark|fluidra|qp.*pisc|quimicamp|ctx/],
];

function detectCluster(kw: string): string {
  const lower = kw.toLowerCase();
  for (const [name, re] of CLUSTER_RULES) {
    if (re.test(lower)) return name;
  }
  return "Otros";
}

// ═══ LOCAL KEYWORD CLASSIFICATION ═══
function classifyKeywords(keywords: any[]): any[] {
  return keywords.map((k: any) => {
    const kw = (k.kw || "").toLowerCase();
    return {
      ...k,
      phase: detectPhase(kw, k.pos, k.ctr),
      intent: detectIntent(kw),
      archs: detectArchs(kw),
      cluster: detectCluster(kw),
    };
  });
}

function detectPhase(kw: string, pos: number, ctr: number): string {
  if (/recambio|repuesto|manual|pieza|part|replacement|invernante|invernaje|post.?venta/.test(kw)) return "Post-venta";
  if (/quimipool|quimpool|quimipol/.test(kw)) return "Compra";
  if (/^\d{4,}|tekna evo|seko |espa |dolphin |innowater |filtro star|zodiac |beatbot |wybot /.test(kw) && pos < 10) return "Decisión";
  if (/como |cómo |que es|qué es|diferencia|comparati|vs |mejor |cual |tutorial|guia/.test(kw)) return "Investigación";
  if (/precio|cuanto|barato|oferta|comparar|alternativa|opiniones/.test(kw)) return "Evaluación";
  if (/limpiafondos|clorador|depuradora|filtro arena|bomba dosificadora|fotometro|cubierta|robot piscina|valla/.test(kw) && !/como |cómo /.test(kw)) return "Evaluación";
  return "Descubrimiento";
}

function detectIntent(kw: string): string {
  if (/quimipool|quimpool|quimipol|seko |astralpool |espa |zodiac /.test(kw)) return "Navegacional";
  if (/comprar|precio|barato|oferta|tienda|^\d{4,}/.test(kw)) return "Transaccional";
  if (/mejor|comparar|comparativa|vs |opiniones|review|alternativa|top /.test(kw)) return "Comercial";
  if (/como |cómo |que es|qué es|diferencia|cuando|por que|tutorial|guia/.test(kw)) return "Informacional";
  return "Comercial";
}

function detectArchs(kw: string): string[] {
  const archs: string[] = [];
  if (/dosificadora|seko|kontrol|cuadro electrico|panel control|tekna|etatron|bomba.*ph|fotometro|fotómetro|poollab|lovibond|orp|turbidimetro/.test(kw)) archs.push("A4");
  if (/robot|sin cable|automatico|automático|clorador salino|cubierta.*auto|beatbot|wybot|zodiac free|dolphin.*liberty|sora/.test(kw)) archs.push("A3");
  if (/recambio|repuesto|valvula|pierde agua|vidrio filtrante|arena filtro|calibrar|sonda|manual|despiece|part|ersatz|diagram/.test(kw)) archs.push("A2");
  if (/depuradora|productos.*piscina|mantenimiento|cloro para|filtro piscina|como |cómo |gresite|valla|primera|desmontable|gre |escalera/.test(kw)) archs.push("A1");
  if (/quimipool/.test(kw)) return ["A1","A2","A3","A4"];
  if (archs.length === 0) archs.push("A1");
  return archs;
}

// ═══ CLUSTER AGGREGATION ═══
type ClusterData = {
  name: string;
  kwCount: number;
  totalClicks: number;
  totalImp: number;
  avgPos: number;
  avgCtr: number;
  topKws: { kw: string; clicks: number; imp: number; pos: number }[];
  phases: Record<string, number>;
  weakKws: { kw: string; imp: number; pos: number }[];
};

function buildClusterSummary(kws: any[]): ClusterData[] {
  const clusters: Record<string, any[]> = {};
  kws.forEach(k => {
    const cl = k.cluster || "Otros";
    if (!clusters[cl]) clusters[cl] = [];
    clusters[cl].push(k);
  });

  return Object.entries(clusters)
    .map(([name, items]) => {
      const totalClicks = items.reduce((s, k) => s + k.clicks, 0);
      const totalImp = items.reduce((s, k) => s + k.imp, 0);
      const avgPos = items.length ? +(items.reduce((s, k) => s + k.pos, 0) / items.length).toFixed(1) : 0;
      const avgCtr = totalImp > 0 ? +(totalClicks / totalImp * 100).toFixed(2) : 0;
      const sorted = [...items].sort((a, b) => b.imp - a.imp);
      const topKws = sorted.slice(0, 5).map(k => ({ kw: k.kw, clicks: k.clicks, imp: k.imp, pos: +k.pos.toFixed(1) }));
      const weakKws = sorted.filter(k => k.imp > 100 && k.pos > 15).slice(0, 3).map(k => ({ kw: k.kw, imp: k.imp, pos: +k.pos.toFixed(1) }));

      const phases: Record<string, number> = {};
      items.forEach(k => { phases[k.phase] = (phases[k.phase] || 0) + k.clicks; });

      return { name, kwCount: items.length, totalClicks, totalImp, avgPos, avgCtr, topKws, phases, weakKws };
    })
    .sort((a, b) => b.totalImp - a.totalImp);
}

function buildPhaseSummary(kws: any[]): Record<string, { count: number; clicks: number; imp: number; avgPos: number }> {
  const phases: Record<string, any[]> = {};
  kws.forEach(k => {
    if (!phases[k.phase]) phases[k.phase] = [];
    phases[k.phase].push(k);
  });
  const result: Record<string, any> = {};
  Object.entries(phases).forEach(([p, items]) => {
    result[p] = {
      count: items.length,
      clicks: items.reduce((s, k) => s + k.clicks, 0),
      imp: items.reduce((s, k) => s + k.imp, 0),
      avgPos: +(items.reduce((s, k) => s + k.pos, 0) / items.length).toFixed(1),
    };
  });
  return result;
}

// ═══ CONTEXT BUILDER ═══
function buildContext(
  clusters: ClusterData[],
  phases: Record<string, any>,
  allKws: any[],
  pages: any[],
  revenue: any,
  domain: string
): string {
  let ctx = `DOMINIO: ${domain}\n`;
  ctx += `TOTAL: ${allKws.length} keywords, ${allKws.reduce((s, k) => s + k.clicks, 0).toLocaleString()} clicks, ${allKws.reduce((s, k) => s + k.imp, 0).toLocaleString()} impresiones (28d)\n`;
  if (revenue) ctx += `REVENUE 30d: EUR${revenue.total}, ${revenue.transactions} transacciones, ${revenue.sessions} sesiones\n`;
  ctx += `SECTOR: tienda online de piscinas, mantenimiento, quimicos, robots limpiafondos, cubiertas y recambios\n\n`;

  ctx += `=== CLUSTERS SEMANTICOS (de mayor a menor volumen) ===\n`;
  clusters.forEach(cl => {
    ctx += `\n> ${cl.name}: ${cl.kwCount} kws, ${cl.totalClicks} clicks, ${cl.totalImp.toLocaleString()} imp, pos.media ${cl.avgPos}, CTR ${cl.avgCtr}%\n`;
    ctx += `  Top: ${cl.topKws.map(k => `"${k.kw}" (${k.imp}imp, pos.${k.pos})`).join(" | ")}\n`;
    if (cl.weakKws.length) {
      ctx += `  Oportunidad perdida: ${cl.weakKws.map(k => `"${k.kw}" pos.${k.pos} con ${k.imp}imp`).join(" | ")}\n`;
    }
    const phaseStr = Object.entries(cl.phases).map(([p, c]) => `${p}:${c}`).join(", ");
    ctx += `  Fases: ${phaseStr}\n`;
  });

  ctx += `\n=== DISTRIBUCION POR FASE ===\n`;
  Object.entries(phases).forEach(([p, d]) => {
    ctx += `${p}: ${d.count} kws, ${d.clicks} clicks, ${d.imp.toLocaleString()} imp, pos.media ${d.avgPos}\n`;
  });

  if (pages.length) {
    ctx += `\n=== TOP PAGINAS GA4 ===\n`;
    pages.forEach(p => {
      ctx += `${p.page} | ses:${p.sessions} eng:${p.engaged} rev:EUR${p.revenue}\n`;
    });
  }

  ctx += `\n=== PATRONES ===\n`;
  const intlKws = allKws.filter(k => /pièces|ersatz|onderdelen|duikplank|glijbaan|zwembad|pompe|recinzione|copertura|couverture|boia|escada|pedra|piscine/.test(k.kw));
  if (intlKws.length > 0) ctx += `- ${intlKws.length} busquedas en otros idiomas (FR, DE, NL, PT, IT) = demanda internacional\n`;

  const refKws = allKws.filter(k => /^\d{5,}|^[a-z]{2,3}\d{3,}|\d{7}/.test(k.kw));
  if (refKws.length > 0) ctx += `- ${refKws.length} busquedas por referencia/SKU exacta = usuarios expertos buscando piezas concretas\n`;

  const problemKws = allKws.filter(k => /como |cómo |pierde agua|no arranca|eliminar algas|limpiar filtro|cambiar arena|que es el/.test(k.kw));
  if (problemKws.length > 0) ctx += `- ${problemKws.length} busquedas de problemas/soluciones = oportunidad contenido educativo\n`;

  const brandKws = allKws.filter(k => /quimipool|quimpool|quimipol/.test(k.kw));
  ctx += `- ${brandKws.length} busquedas de marca (${brandKws.reduce((s, k) => s + k.clicks, 0)} clicks) vs ${allKws.length - brandKws.length} genericas\n`;

  ctx += `\nGenera el JSON con arquetipos, pain_points, insights, content_gaps y recommendations basandote en estos DATOS REALES.`;
  return ctx;
}

function buildDefaultArchetypes(domain: string) {
  return [
    {id:"A1",name:"El Preparador de Temporada",icon:"\ud83c\udfca",desc:"Propietario que activa su piscina en abril-mayo. Busca depuradoras, filtros, quimicos basicos. Primer contacto con el e-commerce. Necesita guias y packs por m3.",pct:35,color:"#00b4d8"},
    {id:"A2",name:"El Manitas Reparador",icon:"\ud83d\udd27",desc:"Veterano que busca recambios exactos por referencia, despieces y manuales. Compra recurrente de piezas Astralpool, ESPA, Seko. Sabe lo que necesita.",pct:25,color:"#0d6e5b"},
    {id:"A3",name:"El Automatizador Premium",icon:"\u26a1",desc:"Quiere robots sin cable (Dolphin, Wybot, Beatbot), cloradores salinos Innowater, cubiertas automaticas. Investiga mucho, ticket alto EUR400-1.200.",pct:25,color:"#d97706"},
    {id:"A4",name:"El Tecnico Profesional",icon:"\ud83c\udfd7\ufe0f",desc:"Instalador o piscinero. Bombas dosificadoras Seko, fotometros Hanna/Lovibond, controladores ORP. Compra tecnica B2B.",pct:15,color:"#7c3aed"},
  ];
}

const SYSTEM_PROMPT = `Eres un consultor SEO senior especializado en e-commerce. Analizas datos REALES de Search Console y Analytics de una tienda online de piscinas en Espana. 

Tu trabajo es generar arquetipos de usuario, pain points y recomendaciones que reflejen los PATRONES REALES de busqueda que ves en los clusters semanticos. No inventes, basa todo en los datos proporcionados.

Devuelve SOLO un JSON (sin texto, sin backticks, sin explicacion) con esta estructura exacta:

{
  "archetypes": [
    {
      "id": "A1",
      "name": "nombre especifico del negocio (no generico)",
      "icon": "emoji",
      "desc": "2-3 frases MUY especificas: que busca, cuando, ticket medio estimado, comportamiento de compra. Basado en los clusters reales que ves.",
      "pct": 35,
      "color": "#00b4d8"
    },
    {"id":"A2","name":"...","icon":"...","desc":"...","pct":25,"color":"#0d6e5b"},
    {"id":"A3","name":"...","icon":"...","desc":"...","pct":25,"color":"#d97706"},
    {"id":"A4","name":"...","icon":"...","desc":"...","pct":15,"color":"#7c3aed"}
  ],
  "pain_points": [
    {
      "title": "frase que diria el USUARIO, no el SEO (ej: 'No se que depuradora necesito para mi piscina')",
      "desc": "1-2 frases con datos reales del cluster: volumen, posicion, CTR",
      "phases": ["Descubrimiento"],
      "archs": ["A1"],
      "sev": 5
    }
  ],
  "insights": {
    "A1": {
      "Descubrimiento": {"t":"que busca/piensa el usuario","f":"como se siente","p":["pain contextualizado"],"g":["oportunidad para la tienda"]},
      "Investigación": {"t":"...","f":"...","p":["..."],"g":["..."]},
      "Evaluación": {"t":"...","f":"...","p":["..."],"g":["..."]},
      "Decisión": {"t":"...","f":"...","p":["..."],"g":["..."]},
      "Compra": {"t":"...","f":"...","p":["..."],"g":["..."]},
      "Post-venta": {"t":"...","f":"...","p":["..."],"g":["..."]}
    },
    "A2": { "Descubrimiento":{...}, "Investigación":{...}, "Evaluación":{...}, "Decisión":{...}, "Compra":{...}, "Post-venta":{...} },
    "A3": { ... las 6 fases ... },
    "A4": { ... las 6 fases ... }
  },
  "content_gaps": [
    {"arch":"A1","phase":"Descubrimiento","title":"Hub de preparacion de temporada","kws":"depuradora piscina, filtro arena, productos piscina","prio":"alta"}
  ],
  "recommendations": [
    {"title":"accion concreta","priority":"ALTA","phase":"Evaluación","type":"CONTENIDO","impact":"estimacion de clicks/revenue","effort":"2-4h","description":"1-2 frases accionables con URLs y keywords especificas"}
  ]
}

REGLAS ESTRICTAS:
1. Los arquetipos DEBEN reflejar los clusters de busqueda reales. Si ves un cluster gordo de "Robots y limpiafondos" con 30+ keywords, uno de los arquetipos debe ser el usuario que busca automatizacion de limpieza.
2. Los pain points se formulan como FRASES DEL USUARIO, no del SEO. Mal: "Posicion 93 para limpiafondos". Bien: "Quiero un robot pero no se cual elegir entre Dolphin, Zodiac y Wybot".
3. Usa los datos de posicion, CTR e impresiones para justificar severidad. Si un cluster tiene CTR < 1% con miles de impresiones, eso es un pain point grave.
4. Los insights deben ser CONCISOS: 1 frase por campo (t, f, p, g). No repitas lo que ya dicen los pain points.
5. Las recomendaciones deben ser accionables con esfuerzo estimado e impacto en EUR si es posible.
6. 8-12 pain points, 10-15 content gaps, 6-10 recomendaciones.
7. IMPORTANTE: Los nombres de las fases en insights DEBEN ser exactamente: Descubrimiento, Investigación, Evaluación, Decisión, Compra, Post-venta (con tildes, tal cual).
8. Responde SOLO con el JSON, sin texto adicional.`;
