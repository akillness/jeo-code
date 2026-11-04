import { runSelfAnalysis } from "./src/agent/dev/self-analysis";
runSelfAnalysis(process.cwd()).then(console.log);
