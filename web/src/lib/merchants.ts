// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Common Canadian merchants and statement phrases, and the starting category
 * (testdata/defaults/categories.json keys) each one usually means. Brand names
 * only: no one's transactions are in here. A household rule always wins over
 * this list, and a household that renamed or archived a starting category
 * simply gets no match for it.
 *
 * Patterns are matched as whole words against the cleaned statement text
 * (see cleanMerchant), longest pattern first, so "uber eats" beats "uber".
 */

export interface KnownMerchant {
  /** Lower case, no accents, words separated by single spaces. */
  patterns: string[];
  /**
   * The category for money out (and refunds of it), a starting category's key; "parent/sub" for a
   * subcategory (shared_subcategories in web-categories.json), the parent when the household has
   * no such subcategory. Null: not for money out.
   */
  expense: string | null;
  /** The category for money in; null: money in from it is a refund of `expense`. */
  income?: string | null;
  /** Usually the same amount every period (bills, rent, pay). */
  fixed?: boolean;
}

const m = (patterns: string[], expense: string | null, extra: Omit<KnownMerchant, "patterns" | "expense"> = {}): KnownMerchant => ({
  patterns, expense, ...extra,
});

export const KNOWN_MERCHANTS: KnownMerchant[] = [
  // Groceries
  m(["loblaws", "loblaw", "no frills", "nofrills", "real canadian superstore", "superstore", "rcss", "metro", "food basics",
    "sobeys", "freshco", "farm boy", "longos", "longo's", "t&t", "t&t supermarket", "save on foods", "safeway", "iga", "provigo",
    "maxi", "zehrs", "fortinos", "your independent grocer", "independent grocer", "valu mart", "foodland", "whole foods",
    "adonis", "nations fresh", "h mart", "galleria supermarket", "costco", "costco wholesale", "walmart supercentre",
    "bulk barn", "co op", "thrifty foods", "giant tiger"], "groceries"),
  // Meal kits: Groceries (the starting categories have no Meal kits subcategory).
  m(["cookunity", "cook unity"], "groceries"),
  // Eating out
  m(["tim hortons", "tims", "starbucks", "second cup", "mcdonald's", "mcdonalds", "a&w", "harvey's", "harveys", "wendy's",
    "wendys", "burger king", "subway", "pizza pizza", "domino's", "dominos", "pizza hut", "little caesars", "kfc", "popeyes",
    "chipotle", "freshii", "mary brown's", "swiss chalet", "boston pizza", "the keg", "montana's", "east side mario's",
    "kelseys", "osmow's", "pita pit", "uber eats", "ubereats", "uber* eats", "skip the dishes", "skipthedishes", "skip",
    "doordash", "dairy queen", "booster juice", "coffee time", "country style", "fat bastard burrito", "mucho burrito",
    "taco bell", "five guys", "st louis bar", "jack astor's", "cora"], "eating_out"),
  // Transport
  m(["presto", "presto fare", "ttc", "go transit", "metrolinx", "oc transpo", "stm", "translink", "compass", "uber", "uber trip",
    "lyft", "petro canada", "petro-canada", "esso", "shell", "ultramar", "pioneer", "husky", "canadian tire gas", "gas bar",
    "mobil", "chevron", "irving", "407 etr", "impark", "green p", "honk", "precise parklink", "via rail", "communauto",
    "bike share", "rent a car", "enterprise rent a car", "car rental"], "transport"),
  // Utilities (bills)
  m(["rogers", "bell", "bell canada", "bell mobility", "telus", "fido", "koodo", "virgin plus", "virgin mobile",
    "freedom mobile", "chatr", "public mobile", "lucky mobile", "videotron", "shaw", "cogeco", "teksavvy", "eastlink",
    "hydro one", "toronto hydro", "alectra", "hydro ottawa", "hydro quebec", "hydro-quebec", "bc hydro", "enbridge",
    "enbridge gas", "fortis", "fortisbc", "epcor", "atco", "reliance home comfort", "enercare", "city of toronto water"],
    "utilities", { fixed: true }),
  // Subscriptions › Streaming & entertainment: names that only ever mean the service.
  m(["netflix", "spotify", "disney plus", "disneyplus", "disney+", "crave", "prime video", "primevideo", "amazon prime video",
    "apple tv+", "apple tv plus", "youtube premium", "youtubepremium", "apple music", "paramount+"],
    "subscriptions/streaming", { fixed: true }),
  // Subscriptions › Software: developer tools, mail and browser services.
  m(["vercel", "vercel inc", "mozilla", "mozillacorp", "mozilla vpn", "superhuman", "superhuman mail", "openrouter", "openrouter inc"],
    "subscriptions/software", { fixed: true }),
  // Subscriptions (the rest; "apple.com/bill" could be any of Apple's services)
  m(["amazon prime", "apple com bill", "apple.com/bill", "itunes", "google storage", "google one", "audible", "xbox",
    "playstation network", "nintendo", "patreon", "icloud", "microsoft 365", "dropbox", "openai", "chatgpt"],
    "subscriptions", { fixed: true }),
  // Shopping
  m(["amazon", "amazon ca", "amazon.ca", "amzn", "amzn mktp", "amazon mktplace", "walmart", "canadian tire", "home depot",
    "rona", "lowe's", "ikea", "best buy", "staples", "winners", "homesense", "marshalls", "hudson's bay", "the bay",
    "dollarama", "sport chek", "indigo", "chapters", "simons", "uniqlo", "h&m", "old navy", "gap", "aritzia", "lululemon",
    "shein", "temu", "etsy", "ebay", "apple store", "london drugs", "mec", "sephora", "the source", "structube"], "shopping"),
  // Health
  m(["shoppers drug mart", "shoppers", "rexall", "pharmasave", "jean coutu", "guardian pharmacy", "pharmacy", "lenscrafters",
    "dental", "dentist", "physiotherapy", "physio", "goodlife", "goodlife fitness", "planet fitness", "fit4less", "ymca"],
    "health"),
  // Leisure
  m(["cineplex", "landmark cinemas", "ticketmaster", "steam", "steam purchase", "lcbo", "beer store", "the beer store",
    "saq", "bcl", "wine rack", "golf", "eventbrite"], "leisure"),
  // Housing
  m(["rent", "mortgage", "condo fees", "property tax", "property taxes"], "housing", { fixed: true }),
  // Education
  m(["udemy", "coursera", "tuition", "skillshare", "duolingo"], "education"),
  // Gifts and giving
  m(["canadahelps", "donation", "charity"], "gifts"),
  // Government, fees, transfers between people
  m(["cra", "canada revenue agency", "receiver general", "gst credit", "gst/hst credit", "canada child benefit", "ccb",
    "ei canada", "cpp", "oas"], "other", { income: "other_income" }),
  m(["e-transfer", "e transfer", "etransfer", "interac e-transfer", "interac etransfer", "email money transfer"], "other",
    { income: "other_income" }),
  m(["service charge", "monthly fee", "monthly account fee", "nsf", "overdraft", "overdraft interest", "atm fee",
    "annual fee", "membership fee"], "fees"),
  m(["interest charge", "interest charges", "purchase interest", "cash advance interest"], "debt_payments", { fixed: false }),
  m(["interest", "interest earned", "deposit interest", "interest paid", "interest credit"], null, { income: "interest" }),
  m(["cashback", "cash back"], null, { income: "other_income" }),
  // Insurance (the kind, life, home, auto or health, is read from the words: categorize.ts insuranceKind)
  m(["rbcins", "rbc insurance", "rbc ins", "sun life", "manulife", "canada life", "great west life", "desjardins insurance",
    "intact insurance", "td insurance", "belairdirect", "belair direct", "aviva", "allstate", "co operators", "cooperators",
    "wawanesa", "economical insurance", "sonnet", "sonnet insurance", "square one insurance", "pc insurance",
    "blue cross", "green shield", "securian", "empire life", "industrial alliance", "ia financial", "life insurance",
    "home insurance", "tenant insurance", "auto insurance", "car insurance", "insurance premium"], "insurance", { fixed: true }),
  // Pay
  m(["payroll", "payroll deposit", "pay deposit", "direct deposit", "salary", "pay", "adp", "ceridian", "dayforce",
    "wagepoint"], null, { income: "salary", fixed: true }),
];
