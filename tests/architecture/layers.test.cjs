const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

function TypeScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? TypeScriptFiles(target) : entry.name.endsWith(".ts") ? [target] : [];
  });
}

function forbiddenImports(relativeDirectory, patterns) {
  return TypeScriptFiles(path.join(root, relativeDirectory)).flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    return patterns.some((pattern) => pattern.test(source))
      ? [path.relative(root, file)]
      : [];
  });
}

test("domain não depende de camadas externas", () => {
  assert.deepEqual(forbiddenImports("src/domain", [
    /from\s+["'][^"']*application/,
    /from\s+["'][^"']*infrastructure/,
    /@vercel\/node/,
    /@supabase\/supabase-js/,
    /src\/providers|\.\.\/\.\.\/providers/,
  ]), []);
});

test("application depende de ports/domain, não de infrastructure ou SDKs", () => {
  assert.deepEqual(forbiddenImports("src/application", [
    /from\s+["'][^"']*infrastructure/,
    /@vercel\/node/,
    /@supabase\/supabase-js/,
  ]), []);
});

test("módulos legados removidos não reaparecem", () => {
  for (const file of [
    "src/engine/rules.ts",
    "src/engine/decision.ts",
    "src/engine/riskConfig.ts",
    "src/engine/fingerprintScore.ts",
    "src/cache/decisionCache.ts",
    "src/cache/supabaseDecisionCache.ts",
    "src/log/decisionLog.ts",
    "src/supabase/client.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});
