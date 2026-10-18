// SPDX-License-Identifier: GPL-3.0-or-later
// POST /api/categorize: the categorizer step of categorisation, for a
// signed-in person only. The browser sends the lines no rule, transfer or
// debt pattern, or known merchant recognised; the answers are mapped onto the
// household's categories in the browser (lib/categorizer.ts), and an unsure
// one is sent to review. Jev by default (TYPESAFE_API_KEY); off without a key.
import { NextResponse } from "next/server";
import { categorize, provider, readItems } from "@/lib/server/categorizer";
import { JEV_CUTOFF, JEV_MODEL } from "@/lib/server/jev";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const env = () => ({
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  FULLA_CATEGORIZER_MODEL: process.env.FULLA_CATEGORIZER_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  FULLA_CATEGORIZER: process.env.FULLA_CATEGORIZER,
});

export async function GET() {
  const p = provider(env());
  return NextResponse.json(
    { enabled: p !== "off", provider: p, ...(p === "jev" ? { model: JEV_MODEL, review_below: JEV_CUTOFF } : {}) },
    { headers: { "cache-control": "no-store" } },
  );
}

/** True when the bearer token is a live session of this project's Supabase Auth. */
async function signedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!/^Bearer \S+$/.test(auth) || !url || !anon) return false;
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/user`, { headers: { apikey: anon, authorization: auth }, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const e = env();
  if (provider(e) === "off") return NextResponse.json({ results: {}, stopped: "off" });
  if (!(await signedIn(req))) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  const items = readItems(body);
  if (!items) return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  return NextResponse.json(await categorize(items, e), { headers: { "cache-control": "no-store" } });
}
