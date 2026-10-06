/**
 * Checks the translations: every English key has a Hindi text, there are no extra Hindi keys,
 * the {placeholders} of each pair are identical, and no Hindi text is empty or just the English one.
 * TypeScript already enforces the keys; this adds the placeholders.
 *
 *   pnpm --filter web check:i18n
 *
 * Runs with Node's built-in TypeScript support (the dictionaries only use type-only imports).
 */
import { en } from "../src/lib/i18n/messages.en.ts";
import { hi } from "../src/lib/i18n/messages.hi.ts";

const placeholders = (text) =>
  [...text.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

const problems = [];
for (const key of Object.keys(en)) {
  if (!(key in hi)) {
    problems.push(`missing Hindi text: ${key}`);
    continue;
  }
  if (!hi[key].trim()) problems.push(`empty Hindi text: ${key}`);
  if (placeholders(en[key]) !== placeholders(hi[key])) {
    problems.push(
      `placeholders differ in ${key}: en {${placeholders(en[key])}} hi {${placeholders(hi[key])}}`,
    );
  }
}
for (const key of Object.keys(hi)) {
  if (!(key in en)) problems.push(`Hindi key without English: ${key}`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`i18n ok: ${Object.keys(en).length} texts in English and Hindi`);
