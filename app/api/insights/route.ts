export const maxDuration = 60;

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ enabled: !!process.env.ANTHROPIC_API_KEY });
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ enabled: false });
  }
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "No auth" }, { status: 401 });

  const body = await req.json();
  const { keywords = [], pages = [], revenue = {}, domain = "" } = body;

  // Classify locally first
  const classified = keywords.map((k: any) => ({
    ...k,
    phase: getPhase(k.kw, k.pos),
    intent: getIntent(k.kw),
    archs: getArchs(k.kw),
  }));

  // Build tiny context: just top 15 keywords + revenue
  const top15 = classified.slice(0, 15).map((k: any) =>
    `${k.kw} | clicks:${k.clicks} imp:${k.imp} pos:${k.pos}`
  ).join("\n");

  const prompt = `Dominio: ${domain}. Revenue 30d: ${revenue.total || 0} EUR. Top keywords:\n${top15}\n\nDevuelve SOLO JSON con: archetypes (4, id A1-A4, name, icon emoji, desc 1 frase, pct number, color string), pain_points (5, title, desc, phases array, archs array, sev 1-5), insights objeto vacio {}, content_gaps (5, arch, phase, title, kws, prio), recommendations (3, title, priority, phase, type, impact, effort, description). Sin texto extra.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Anthropic error:", res.status, err.slice(0, 200));
      return NextResponse.json({ enabled: true, journey: { keywords_classified: classified } });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    let ai = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) ai = JSON.parse(m[0]);
    } catch (e) {
      console.error("JSON parse error");
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
    return NextResponse.json({ enabled: true, journey: { keywords_classified: classified } });
  }
}

function getPhase(kw: string, pos: number): string {
  const k = (kw || "").toLowerCase();
  if (/recambio|repuesto|manual|pieza|part|replacement|invern/.test(k)) return "Post-venta";
  if (/quimipool|quimpool|quimipol/.test(k)) return "Compra";
  if (/precio|cuanto|barato|oferta|comparar|opiniones/.test(k)) return "Evaluación";
  if (/como |cómo |que es|qué es|diferencia|mejor |cual /.test(k)) return "Investigación";
  if (/limpiafondos|clorador|depuradora|filtro|robot|cubierta|bomba/.test(k)) return "Evaluación";
  return "Descubrimiento";
}

function getIntent(kw: string): string {
  const k = (kw || "").toLowerCase();
  if (/quimipool|astralpool|espa |seko |zodiac /.test(k)) return "Navegacional";
  if (/comprar|precio|barato|oferta/.test(k)) return "Transaccional";
  if (/como |cómo |que es|qué es|tutorial/.test(k)) return "Informacional";
  return "Comercial";
}

function getArchs(kw: string): string[] {
  const k = (kw || "").toLowerCase();
  if (/quimipool/.test(k)) return ["A1", "A2", "A3", "A4"];
  if (/seko|tekna|dosificadora|fotometro|orp|kontrol/.test(k)) return ["A4"];
  if (/robot|dolphin|wybot|beatbot|zodiac|clorador salino|cubierta/.test(k)) return ["A3"];
  if (/recambio|repuesto|part|manual|despiece/.test(k)) return ["A2"];
  return ["A1"];
}

function defaultArchs() {
  return [
    { id: "A1", name: "Preparador Temporada", icon: "🏊", desc: "Activa piscina abr-may. Depuradoras, filtros, químicos.", pct: 35, color: "#00b4d8" },
    { id: "A2", name: "Manitas Reparador", icon: "🔧", desc: "Busca recambios exactos por referencia.", pct: 25, color: "#0d6e5b" },
    { id: "A3", name: "Automatizador", icon: "⚡", desc: "Robots sin cable, cloradores salinos. Ticket alto.", pct: 25, color: "#d97706" },
    { id: "A4", name: "Técnico Pro", icon: "🏗️", desc: "Bombas dosificadoras, fotómetros. B2B.", pct: 15, color: "#7c3aed" },
  ];
}
