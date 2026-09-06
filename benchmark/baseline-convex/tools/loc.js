// tools/loc.js -- reproducible line count. Run: npm run loc
//
// COUNTING METHOD -- identical rules to the Supabase baseline so the two
// numbers are comparable:
//
//   APPLICATION  = code a developer building Vault on Convex must write and own.
//   COMPARISON / TOOLING = artefacts that exist only to support this benchmark.
//                  NOT counted.
//   GROSS = every line in APPLICATION files, blanks and comments included.
//   NET   = GROSS minus blank lines and comment-only lines (`//`, `/* */`).
//
// There is no "PLATFORM (not counted)" group here, unlike the Supabase
// baseline. That is not an oversight: Convex supplies its platform as a
// service and a hosted component, so nothing had to be reimplemented locally
// to make this baseline readable. The trade-off is that nothing could be
// executed either.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const GROUPS = {
  APPLICATION: [
    ["convex/schema.ts", "tables + indexes (no access rules are expressible here)"],
    ["convex/convex.config.ts", "install the R2 component"],
    ["convex/auth.config.ts", "identity provider"],
    ["convex/model/auth.ts", "the entire authorization model, as callable functions"],
    ["convex/model/audit.ts", "tamper-evident hash chain + verifier"],
    ["convex/r2.ts", "R2 client, keying, upload flow, presigning"],
    ["convex/documents.ts", "document queries/mutations"],
    ["convex/members.ts", "org membership + role changes"],
    ["convex/shares.ts", "share links: expiry, password, cap, revocation"],
    ["convex/audit.ts", "audit read surface"],
    ["convex/http.ts", "the two byte-serving endpoints"],
  ],
  "COMPARISON / TOOLING (not counted)": [
    ["convex/variantA_convexFileStorage.ts", "pure Convex File Storage variant, for the report"],
    ["tools/loc.js", ""],
  ],
};

function count(rel) {
  const lines = readFileSync(join(root, rel), "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let net = 0;
  let inBlock = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (inBlock) {
      if (l.includes("*/")) inBlock = false;
      continue;
    }
    if (l === "") continue;
    if (l.startsWith("//") || l.startsWith("*")) continue;
    if (l.startsWith("/*")) {
      if (!l.includes("*/")) inBlock = true;
      continue;
    }
    net++;
  }
  return { gross: lines.length, net };
}

let appGross = 0;
let appNet = 0;
for (const [group, files] of Object.entries(GROUPS)) {
  console.log(`\n${group}`);
  let g = 0;
  let n = 0;
  for (const [rel, note] of files) {
    const c = count(rel);
    g += c.gross;
    n += c.net;
    console.log(
      `  ${String(c.gross).padStart(5)} ${String(c.net).padStart(5)}  ${rel}${note ? "   -- " + note : ""}`,
    );
  }
  console.log(`  ${String(g).padStart(5)} ${String(n).padStart(5)}  SUBTOTAL (gross, net)`);
  if (group === "APPLICATION") {
    appGross = g;
    appNet = n;
  }
}
console.log(`\nAPPLICATION LOC:  gross ${appGross}   net ${appNet}`);
