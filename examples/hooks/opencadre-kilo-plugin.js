// OpenCadre for Kilo Code, loaded by Kilo from a config `plugin` entry that `opencadre connect` writes. Kilo calls
// EVERY function this module exports as a plugin, so it exports exactly one; everything else lives in
// opencadre-kilo-core.mjs beside it.
import { createKiloPlugin } from "./opencadre-kilo-core.mjs";

export const OpenCadre = createKiloPlugin();
