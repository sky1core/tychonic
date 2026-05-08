import { formatContractCheckResults, runContractChecks } from "./index.js";

const results = await runContractChecks();
const output = formatContractCheckResults(results);
const failed = results.some((result) => !result.ok);

if (failed) {
  console.error(output);
  process.exitCode = 1;
} else {
  console.log(output);
}
