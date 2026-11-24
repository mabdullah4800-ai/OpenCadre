#!/usr/bin/env node
/** Zero-token ingest + agent wake. Substantive replies require LLM agent turn. */
process.env.OPENCADRE_ZERO_TOKEN ??= "1";
import { startWatcher } from "./inbox-watcher.mjs";
startWatcher();
