import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCompetitive } from "./harness.js";
import { runMemoryBench } from "./memory-bench.js";
import { FAULTS } from "./simulator.js";

const outDir = join(fileURLToPath(new URL("../..", import.meta.url)), "output");

function pct(x) { return `${(x * 100).toFixed(1)}%`; }
function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => (i === 0 ? pad(c, widths[i]) : rpad(c, widths[i]))).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

async function main() {
  const trials = Number(process.argv[2] ?? 1000);
  const faulty = await runCompetitive({ trials, faultRate: 0.3, readFaultRate: 0.02, seed: 42 });
  const clean = await runCompetitive({ trials, faultRate: 0, readFaultRate: 0, seed: 42 });
  const memory = runMemoryBench();

  console.log(`=== Accuracy under fault injection (${trials} actions, 30% fault rate, 2% flaky read path, seed 42) ===\n`);
  console.log(table(
    ["strategy", "silent failures", "caught", "catch rate", "orphaned writes", "escalated", "duplicates", "partials left", "end state correct"],
    faulty.results.map((r) => [r.name, r.silentFailures, r.caught, pct(r.catchRate), r.orphans, r.escalations, r.duplicates, r.partialsLeft, pct(r.endStateCorrectRate)]),
  ));

  console.log(`\n=== Silent failures by fault type (of ${faulty.results[0].faultsTotal} injected) ===\n`);
  console.log(table(
    ["strategy", ...FAULTS],
    faulty.results.map((r) => [r.name, ...FAULTS.map((f) => `${r.byFault[f].silent}/${r.byFault[f].n}`)]),
  ));

  console.log(`\n=== Time: cost per action (simulated API: write 120ms, read 60ms, delete 100ms) ===\n`);
  console.log(table(
    ["strategy", "calls/action (faulty)", "ms/action (faulty)", "calls/action (clean)", "ms/action (clean)"],
    faulty.results.map((r, i) => [r.name, r.apiCallsPerAction.toFixed(2), r.latencyMsPerAction.toFixed(0), clean.results[i].apiCallsPerAction.toFixed(2), clean.results[i].latencyMsPerAction.toFixed(0)]),
  ));

  console.log(`\n=== Memory: ${memory.services} services, ${memory.observations} observations, ${memory.ownershipChanges} real ownership changes, top-${memory.topK} retrieval ===\n`);
  const a = memory.appendOnly, r = memory.reconciling;
  console.log(table(
    ["metric", "append-only notes", "reconciling store"],
    [
      ["notes stored", a.notes, `${r.notes} (${r.activeFacts} active + ${r.historyRetained} superseded)`],
      ["queries with contradictory context", `${a.contradictoryContexts} (${pct(a.contradictoryContextRate)})`, `${r.contradictoryContexts} (${pct(r.contradictoryContextRate)})`],
      ["current owner answered correctly", "n/a (model must pick)", `${r.currentOwnerCorrect} (${pct(r.currentOwnerCorrectRate)})`],
      ["ownership changes detected as revisions", `${a.revisionsDetected}`, `${r.revisionsDetected}/${memory.ownershipChanges} (${pct(r.revisionRecall)})`],
      ["confirmations mistaken for changes", "n/a", r.falseRevisions],
    ],
  ));

  console.log("\nBaselines represent:");
  for (const s of faulty.results) console.log(`  ${pad(s.name, 18)} ${s.represents}`);
  console.log(`  ${pad("append-only", 18)} ${a.represents}`);

  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `competitive-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify({ faulty, clean, memory }, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main();
