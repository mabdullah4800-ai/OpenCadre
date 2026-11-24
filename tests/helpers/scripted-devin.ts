// A stand-in for Devin's model backend, for LIVE tests of the real `devin` CLI with no account. Devin has no
// bring-your-own-model setting, so this answers its (undocumented) protocol as far as a scripted run needs, as measured
// on devin 3000.6.11: WINDSURF_API_SERVER_URL points the CLI here, a Connect-protobuf chat stream carries text in field 3
// and a tool call in field 6 ({1: id, 2: name, 3: arguments JSON}), and GetCliTeamSettings must answer field 1 = true or
// MCP servers never start. Tied to that build: if a Devin update breaks it, the live test fails loudly, it never passes
// by accident.
//
// Each chat request (a large protobuf body) takes the next step: { name, args } calls a tool, "done" answers text.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type DevinCall = { name: string; args: object } | "done";
/** A step, or a function of the request it answers (e.g. to read a background shell's id from the last tool result). */
export type DevinStep = DevinCall | ((request: string) => DevinCall);

const vint = (x: number | bigint) => {
  const out: number[] = [];
  let v = BigInt(x);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
};
const field = (n: number, wire: number, payload: Buffer) => Buffer.concat([vint((BigInt(n) << 3n) | BigInt(wire)), payload]);
const str = (n: number, s: string | Buffer) => {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s);
  return field(n, 2, Buffer.concat([vint(b.length), b]));
};
const frame = (b: Buffer, flag = 0) => {
  const h = Buffer.alloc(5);
  h[0] = flag;
  h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
};

export async function scriptedDevin(steps: DevinStep[]): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  let step = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const type = String(req.headers["content-type"] ?? "");
      if (type.includes("connect+proto")) {
        res.writeHead(200, { "content-type": "application/connect+proto" });
        if (body.length >= 5000) {
          seen.push(body.toString("latin1"));
          const next = steps[step++] ?? "done";
          const s = typeof next === "function" ? next(body.toString("latin1")) : next;
          const msg = s === "done" ? str(3, "Done.") : str(6, Buffer.concat([str(1, `call_${step}`), str(2, s.name), str(3, JSON.stringify(s.args))]));
          res.write(frame(msg));
        }
        return res.end(frame(Buffer.from("{}"), 2));
      }
      res.writeHead(200, { "content-type": "application/proto" });
      if (String(req.url).endsWith("/GetCliTeamSettings")) return res.end(Buffer.from("0801", "hex"));
      res.end("");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
