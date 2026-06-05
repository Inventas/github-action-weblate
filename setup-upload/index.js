import { runSetupUploadAction } from "../src/setup-upload.js";

runSetupUploadAction().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
