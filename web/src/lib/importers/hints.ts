// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from core/.../importers/CategoryHints.kt; keep the two in step.
import { DEFAULT_CATEGORIES } from "../defaults";
import { normalizeName } from "../text";

/** Words, beyond the defaults' own names, that mean a starting category. */
const SYNONYMS: Record<string, string[]> = {
  housing: ["alquiler", "hipoteca", "rent", "mortgage", "loyer", "miete", "affitto", "renda", "aluguel"],
  groceries: ["supermercados", "alimentacion", "grocery", "food", "epicerie", "supermarkt", "supermercato", "mercearia"],
  eating_out: ["restaurantes", "restaurante", "restaurant", "bares", "ristoranti", "ristorante"],
  transport: ["transporte publico", "public transport"],
  utilities: ["facturas", "bills", "luz y agua"],
  subscriptions: ["suscripcion", "subscription", "abonnement", "abo", "abbonamento", "assinatura"],
  health: ["sanidad", "medico", "medical"],
  leisure: ["entretenimiento", "entertainment", "divertimento"],
  education: ["formacion", "training", "formation", "formazione", "formacao"],
  gifts: ["regalo", "gift", "cadeau", "geschenk", "regalo", "presente"],
  other: ["otros", "otro", "varios", "others", "misc", "autres", "altro", "altri", "outros"],
  salary: ["nomina", "sueldo", "payroll", "paycheck", "wages", "paie", "lohn", "busta paga", "ordenado"],
  debt_payments: ["debt", "debts", "debt payment", "loans", "loan payments", "deudas", "dettes", "schulden", "debiti", "dividas"],
  insurance: ["insurance", "insurances", "seguro", "assurance", "versicherung", "assicurazione"],
  interest: ["interest income", "interest earned", "bank interest", "zinsertrag"],
  fees: ["fee", "bank fees", "bank charges", "service charges", "comisiones bancarias", "frais bancaires"],
  investment_income: ["investment income", "dividends", "dividend income", "dividendes", "dividendos", "dividenden"],
  other_income: ["otros", "varios", "others", "autres", "sonstige", "altri", "outros"],
};

const NAMES: Record<string, Set<string>> = Object.fromEntries(
  DEFAULT_CATEGORIES.map((d) => [d.key, new Set([...Object.values(d.name), ...(SYNONYMS[d.key] ?? [])].map(normalizeName))]),
);

/** The starting categories a name means, most likely first; empty when it is none of them. */
export function defaultKeys(name: string): string[] {
  const n = normalizeName(name);
  return DEFAULT_CATEGORIES.map((d) => d.key).filter((k) => NAMES[k].has(n));
}

export function synonymsOf(keys: string[]): Set<string> {
  return new Set(keys.flatMap((k) => SYNONYMS[k] ?? []).map(normalizeName));
}

/** Word beginnings → icon, first match wins. */
const ICONS: [string[], string][] = [
  [["farmac", "pharm", "apothek", "drogu"], "local_hospital"],
  [["combust", "gasolin", "gasoil", "fuel", "petrol", "carbur", "benzin", "tanken", "diesel"], "local_gas_station"],
  [["coche", "voiture", "macchina", "carro", "parking", "aparcamiento", "taller", "itv"], "directions_car"],
  [["mascot", "perro", "gato", "veterin", "pet", "animal", "haustier", "chien", "chat"], "pets"],
  [["viaje", "vacacion", "travel", "vuelo", "flight", "hotel", "voyage", "reise", "viagg", "viage", "ferias"], "flight"],
  [["telefon", "movil", "phone", "mobile", "internet", "fibra", "handy", "telemovel"], "smartphone"],
  [["gimnas", "gym", "deport", "sport", "fitness", "padel", "piscina"], "fitness_center"],
  [["bebe", "nino", "ninos", "hijo", "guarder", "child", "kid", "baby", "enfant", "kind", "bambin", "crianca"], "child_care"],
  [["cafe", "coffee", "cafeter", "kaffee"], "local_cafe"],
  [["cine", "teatro", "concierto", "theat", "cinema", "concert", "kino"], "theater_comedy"],
  [["loter", "lotto", "apuesta", "quiniela", "bet", "gioco", "jogo"], "confirmation_number"],
  [["pelu", "barber", "hair", "estetic", "friseur", "coiff", "parrucch", "cabeleir"], "content_cut"],
  [["seguro", "insur", "assur", "versicher", "assicur"], "shield"],
  [["financ", "prestamo", "credito", "loan", "banco", "bank", "impuesto", "taxes", "hacienda", "fianza", "deposit", "steuer", "tasse", "impost", "kredit"], "account_balance"],
  [["ropa", "cloth", "zapat", "moda", "vetement", "kleid", "abbigl", "roupa"], "checkroom"],
  [["domicilio", "delivery", "restaur", "comida", "bar", "tapas", "pizza"], "restaurant"],
  [["super", "mercado", "carnic", "fruter", "panader", "pescader", "grocer", "courses", "lebensmittel", "spesa"], "shopping_cart"],
  [["luz", "agua", "electric", "suministr", "gas", "strom", "wasser", "bollett"], "bolt"],
  [["suscrip", "subscri", "streaming", "abonn", "abbonam", "assinat"], "subscriptions"],
  [["educa", "colegio", "school", "curso", "libro", "univers", "schule", "scuola", "escola"], "school"],
  [["regalo", "gift", "cumple", "cadeau", "geschenk", "present"], "redeem"],
  [["transport", "bus", "metro", "tren", "taxi", "train", "bahn"], "directions_bus"],
  [["alquiler", "hipoteca", "hogar", "casa", "home", "rent", "mueble", "logement", "wohn", "miete"], "home"],
  [["salud", "health", "medic", "dentist", "hospital", "sante", "gesund", "salute", "saude", "optica"], "favorite"],
  [["compra", "shop", "achat", "einkauf", "acquist"], "shopping_bag"],
  [["ocio", "leisure", "loisir", "freizeit", "juego", "game", "lazer"], "sports_esports"],
  [["nomina", "sueldo", "salario", "salary", "paie", "gehalt", "stipend", "transfer"], "payments"],
  [["ahorro", "saving", "inversion", "invest", "epargne", "sparen", "rispar", "poupan"], "savings"],
  [["trabajo", "work", "oficina", "office", "travail", "arbeit", "lavoro", "trabalho"], "work"],
  [["otro", "other", "vario", "misc", "autre", "sonstig", "altr", "outro"], "more_horiz"],
];

/** An icon for a new category called name, or null when nothing in it suggests one. */
export function iconFor(name: string): string | null {
  const key = defaultKeys(name)[0];
  if (key) return DEFAULT_CATEGORIES.find((d) => d.key === key)!.icon;
  const words = normalizeName(name).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  for (const [stems, icon] of ICONS) if (words.some((w) => stems.some((s) => w.startsWith(s)))) return icon;
  return null;
}
