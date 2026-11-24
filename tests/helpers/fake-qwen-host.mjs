// Plays a Qwen Code process for tests: it is the PARENT of the OpenCadre proxy, exactly as Qwen is, so the proxy finds
// it by walking its own ancestry (scripts/opencadre-config.mjs, locateHost) and a hook can be told its pid.
//   FAKE_QWEN_PROXY=<proxy.mjs> node fake-qwen-host.mjs [host flags, e.g. --acp] --client qwen
// Its own command line carries the host flags, which is where the proxy looks for Qwen's ACP mode. Tests set
// QWEN_CODE_CLI to this file, as Qwen sets it to its own entry script.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, [process.env.FAKE_QWEN_PROXY, "--client", "qwen"], { stdio: "inherit", env: process.env, windowsHide: true });
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
