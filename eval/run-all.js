import { runFaultInjection } from "./fault-injection.js";
import { runRollbackFidelity } from "./rollback-fidelity.js";
import { runMemoryScenarios } from "./memory-scenarios.js";
import { runTriStateCoverage } from "./tri-state-coverage.js";
import { runCalibration } from "./calibration.js";
import { runAdversarialCheck } from "./adversarial.js";

async function main() {
  const faultInjection = runFaultInjection(10);
  const rollbackFidelity = await runRollbackFidelity(20);
  const memoryScenarios = runMemoryScenarios();
  const triStateCoverage = runTriStateCoverage();
  const calibration = runCalibration();

  console.log("=== Eval #1: Silent-failure catch rate ===");
  console.log(`${faultInjection.caught}/${faultInjection.trials} caught (${(faultInjection.catchRate * 100).toFixed(0)}%)`);

  console.log("\n=== Eval #2: Rollback fidelity ===");
  console.log(`${rollbackFidelity.exact}/${rollbackFidelity.trials} exact restorations (${(rollbackFidelity.exactRestorationRate * 100).toFixed(0)}%)`);
  console.log(`Excludes: ${rollbackFidelity.excludedFields.join(", ")}`);

  console.log("\n=== Eval #3: Memory scenario accuracy ===");
  console.log(`${memoryScenarios.correct}/${memoryScenarios.total} correct (${(memoryScenarios.accuracy * 100).toFixed(0)}%)`);

  console.log("\n=== Eval #4: Tri-state coverage ===");
  console.log(`Covers all three states: ${triStateCoverage.coversAllThree}; no retry side effect: ${triStateCoverage.noRetrySideEffect}`);

  console.log("\n=== Eval #5: Confidence calibration ===");
  console.log(`Brier score: ${calibration.brierScore.toFixed(3)} (0 = perfect, lower is better)`);

  console.log("\n=== Stretch: Adversarial check ===");
  const adversarial = runAdversarialCheck();
  console.log(`Poisoned content blocked: ${adversarial.blocked}`);
}

main();
