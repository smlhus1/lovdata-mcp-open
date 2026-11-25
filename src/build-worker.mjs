// Builds an index on a thread of its own, so the server keeps answering meanwhile.
import { workerData } from "node:worker_threads";
import { buildDatabase } from "./store.mjs";

buildDatabase(workerData.file, workerData.sources);
