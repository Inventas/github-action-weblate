import { runDownloadAction } from "../src/download.js";

runDownloadAction().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
