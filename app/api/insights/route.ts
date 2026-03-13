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
    // NOW RECEIVES: clusterSummary (string), domain, revenue, phaseSummary, patterns
    // NOT individual keywords - those are classified client-side
    const { clusterSummary = "", domain = "", revenue = {}, phaseSummary = "", patterns = "", classifiedKeywords = [] } = body;

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
        temperature: 0,
        system: PROMPT,
        messages: [{ role: "user", content: `DOMINIO: ${domain}\nRevenue 30d: EUR${revenue.total || 0}, ${revenue.transactions || 0} transacciones\n\n${clusterSummary}\n\n${phaseSummary}\n\n${patterns}\n\nGenera el JSON.` }],
      }),
    });

    if (!res.ok) {
      console.error("Anthropic:", res.status, await res.text().then(t => t.slice(0, 200)));
      return NextResponse.json({ enabled: true, archetypes: null, pain_points: [], content_gaps: [], recommendations: [] });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    let ai: any = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) ai = JSON.parse(m[0]);
    } catch { console.error("JSON parse failed"); }

    return NextResponse.json({
      enabled: true,
      archetypes: padArchetypes(ai?.archetypes),
      pain_points: ai?.pain_points || [],
      content_gaps: ai?.content_gaps || [],
      recommendations: ai?.recommendations || [],
    });
  } catch (e: any) {
    console.error("Insights error:", e.message);
    return NextResponse.json({ enabled: true, archetypes: null, pain_points: [], content_gaps: [], recommendations: [] });
  }
}

function padArchetypes(archs: any[] | null | undefined): any[] {
  const defaults = [
    { id: "A1", name: "El Preparador de Temporada", icon: "\ud83c\udfca", desc: "Activa su piscina en abril-mayo. Depuradoras, filtros, qu\u00edmicos. Ticket \u20ac200-600.", pct: 25, color: "#18181b" },
    { id: "A2", name: "El Cazador de Robots", icon: "\ud83e\udd16", desc: "Investiga robots limpiafondos. Compara Dolphin, Zodiac, Wybot. Ticket \u20ac400-1.200.", pct: 20, color: "#3f3f46" },
    { id: "A3", name: "El Manitas Reparador", icon: "\ud83d\udd27", desc: "Recambios exactos por referencia y despieces. Ticket \u20ac30-150.", pct: 18, color: "#52525b" },
    { id: "A4", name: "El T\u00e9cnico Profesional", icon: "\u2699\ufe0f", desc: "Bombas dosificadoras Seko, fot\u00f3metros Hanna/Lovibond. B2B.", pct: 15, color: "#71717a" },
    { id: "A5", name: "El Propietario de Desmontable", icon: "\ud83c\udfe0", desc: "Piscinas Gre, accesorios b\u00e1sicos. Ticket \u20ac100-400.", pct: 12, color: "#a1a1aa" },
    { id: "A6", name: "El Buscador Internacional", icon: "\ud83c\udf0d", desc: "Busca en FR, DE, NL, PT, IT. Cross-border.", pct: 10, color: "#d4d4d8" },
  ];
  const colors = ["#18181b", "#3f3f46", "#52525b", "#71717a", "#a1a1aa", "#d4d4d8"];
  if (!archs || archs.length === 0) return defaults;
  const result: any[] = [];
  for (let i = 0; i < 6; i++) {
    const id = "A" + (i + 1);
    const existing = archs.find((a: any) => a.id === id) || archs[i];
    if (existing) {
      result.push({ ...existing, id, color: colors[i] });
    } else {
      result.push({ ...defaults[i] });
    }
  }
  return result;
}

const PROMPT = `Eres consultor SEO senior de e-commerce de piscinas en España. Recibes datos REALES de Search Console y competidores. Los clusters incluyen keywords propias (GSC) y keywords de competidores (gaps donde ellos rankean y tú no).

Devuelve SOLO JSON válido (sin texto, sin backticks):

{
  "archetypes": [
    {"id":"A1","name":"nombre MUY específico del sector piscinas","icon":"emoji","desc":"2-3 frases basadas en clusters reales: qué busca, cuándo, ticket, comportamiento","pct":25,"color":"#18181b"},
    {"id":"A2","name":"...","icon":"...","desc":"...","pct":20,"color":"#3f3f46"},
    {"id":"A3","name":"...","icon":"...","desc":"...","pct":18,"color":"#52525b"},
    {"id":"A4","name":"...","icon":"...","desc":"...","pct":15,"color":"#71717a"},
    {"id":"A5","name":"...","icon":"...","desc":"...","pct":12,"color":"#a1a1aa"},
    {"id":"A6","name":"...","icon":"...","desc":"...","pct":10,"color":"#d4d4d8"}
  ],
  "pain_points": [
    {"title":"frase que diría el USUARIO buscando en Google, NO jerga SEO","desc":"dato real: impresiones, posición, CTR o gap vs competidor","phases":["Evaluación"],"archs":["A1"],"sev":5}
  ],
  "content_gaps": [
    {"arch":"A1","phase":"Evaluación","title":"contenido que falta","kws":"keywords concretas","prio":"alta"}
  ],
  "recommendations": [
    {"title":"acción concreta","priority":"ALTA","phase":"Evaluación","type":"SEO","impact":"impacto estimado en EUR/mes","effort":"2h","description":"qué hacer exactamente, con qué URLs y keywords"}
  ]
}

REGLAS:
1. EXACTAMENTE 6 ARQUETIPOS (A1-A6) del sector piscinas basados en clusters. Ni 4 ni 5: SEIS. Buenos ejemplos: "El que prepara la piscina en abril", "El buscador de robots sin cable", "El técnico que busca piezas por referencia exacta". MALOS: "Propietario DIY", "Usuario experto".
2. PAIN POINTS (8-10) como frases de Google: "No sé qué depuradora necesito para mi piscina de 30m3", "Quiero un robot pero hay 50 modelos", "Busco el recambio de mi Aster 99 y no lo encuentro".
3. CONTENT GAPS (8-10): contenidos que debería crear. "Comparativa robots sin cable 2026", "Guía depuradora por m3".
4. RECOMENDACIONES (5-6): accionables con impacto en EUR.
5. Solo JSON.`;
