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
      archetypes: ai?.archetypes || null,
      pain_points: ai?.pain_points || [],
      content_gaps: ai?.content_gaps || [],
      recommendations: ai?.recommendations || [],
    });
  } catch (e: any) {
    console.error("Insights error:", e.message);
    return NextResponse.json({ enabled: true, archetypes: null, pain_points: [], content_gaps: [], recommendations: [] });
  }
}

const PROMPT = `Eres consultor SEO senior de e-commerce de piscinas en España. Recibes datos REALES de Search Console y competidores. Los clusters incluyen keywords propias (GSC) y keywords de competidores (gaps donde ellos rankean y tú no).

Devuelve SOLO JSON válido (sin texto, sin backticks):

{
  "archetypes": [
    {"id":"A1","name":"nombre MUY específico del sector piscinas","icon":"emoji","desc":"2-3 frases: qué busca exactamente, en qué época del año, ticket medio, cómo se comporta. BASADO EN LOS CLUSTERS REALES.","pct":35,"color":"#00b4d8"},
    {"id":"A2","name":"...","icon":"...","desc":"...","pct":25,"color":"#0d6e5b"},
    {"id":"A3","name":"...","icon":"...","desc":"...","pct":25,"color":"#d97706"},
    {"id":"A4","name":"...","icon":"...","desc":"...","pct":15,"color":"#7c3aed"}
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
1. ARQUETIPOS del sector piscinas basados en clusters. Buenos ejemplos: "El que prepara la piscina en abril", "El buscador de robots sin cable", "El técnico que busca piezas por referencia exacta". MALOS: "Propietario DIY", "Usuario experto".
2. PAIN POINTS (8-10) como frases de Google: "No sé qué depuradora necesito para mi piscina de 30m3", "Quiero un robot pero hay 50 modelos", "Busco el recambio de mi Aster 99 y no lo encuentro".
3. CONTENT GAPS (8-10): contenidos que debería crear. "Comparativa robots sin cable 2026", "Guía depuradora por m3".
4. RECOMENDACIONES (5-6): accionables con impacto en EUR.
5. Solo JSON.`;
