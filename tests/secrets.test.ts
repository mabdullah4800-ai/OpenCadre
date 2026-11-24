import { describe, expect, it } from "vitest";
import { maskDeep, maskEventRow, maskSecrets } from "../src/secrets.js";
import { maskSecrets as maskSecretsClient } from "../scripts/opencadre-secrets.mjs";

// Obviously fake values only: every "secret" below is a prefix plus zeros (or a word like hunter2).
const z = (n: number) => "0".repeat(n);

/** [input, masked]: every pattern src/secrets.ts knows. */
const POSITIVE: Array<[string, string]> = [
  // OpenCadre credentials
  [`ALPHA="agt_${z(48)}" node x.mjs`, `ALPHA="agt_***" node x.mjs`],
  [`opencadre bootstrap org_${z(48)}`, "opencadre bootstrap org_***"],
  [`credential dev_${z(48)}`, "credential dev_***"],
  [`join with oci_${z(32)}`, "join with oci_***"],
  [`opencadre connect ocd_${z(10)}`, "opencadre connect ocd_***"],
  [`opencadre connect oc_${z(10)}`, "opencadre connect oc_***"],
  // Bearer tokens
  [`curl -H "Authorization: Bearer abc${z(20)}" https://hub`, `curl -H "Authorization: Bearer ***" https://hub`],
  [`curl -H 'authorization: bearer agt_${z(48)}'`, "curl -H 'authorization: bearer ***'"],
  // Provider tokens
  [`OPENAI=sk-${z(48)}`, "OPENAI=sk-***"],
  [`key sk-proj-${z(48)}`, "key sk-***"],
  [`stripe sk_live_${z(24)}`, "stripe sk_live_***"],
  [`stripe sk_test_${z(24)}`, "stripe sk_test_***"],
  [`stripe rk_live_${z(24)}`, "stripe rk_live_***"],
  [`stripe rk_${z(24)}`, "stripe rk_***"],
  [`paddle pdl_live_apikey_${z(26)}_${z(27)}`, "paddle pdl_live_apikey_***"],
  [`paddle pdl_sdbx_apikey_${z(26)}_${z(27)}`, "paddle pdl_sdbx_apikey_***"],
  [`paddle pdl_ntfset_${z(26)}_${z(32)}`, "paddle pdl_ntfset_***"],
  [`gh ghp_${z(36)}`, "gh ghp_***"],
  [`gh gho_${z(36)}`, "gh gho_***"],
  [`gh ghu_${z(36)}`, "gh ghu_***"],
  [`gh ghs_${z(36)}`, "gh ghs_***"],
  [`gh github_pat_${z(22)}_${z(59)}`, "gh github_pat_***"],
  [`slack xoxb-${z(12)}-${z(12)}`, "slack xoxb-***"],
  [`slack xoxp-${z(12)}-${z(12)}`, "slack xoxp-***"],
  [`slack xoxa-${z(12)}`, "slack xoxa-***"],
  [`slack xoxr-${z(12)}`, "slack xoxr-***"],
  [`aws AKIA${z(16)}`, "aws AKIA***"],
  [`google AIza${z(35)}`, "google AIza***"],
  ["jwt eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZw", "jwt eyJ***"],
  [`npm config set //registry.npmjs.org/:_authToken npm_${z(36)}`, "npm config set //registry.npmjs.org/:_authToken npm_***"],
  // Credentials in URLs
  ["git clone https://user:hunter2@github.com/o/r.git", "git clone https://user:***@github.com/o/r.git"],
  ["psql postgres://token:hunter2@db:5432/app", "psql postgres://token:***@db:5432/app"],
  // Secret-named assignments
  ["export API_KEY=abc123 && rm -rf ./x", "export API_KEY=*** && rm -rf ./x"],
  [`GITHUB_TOKEN=ghp_${z(36)} gh pr list`, "GITHUB_TOKEN=*** gh pr list"],
  ["DB_PASSWORD='hunter2' npm start", "DB_PASSWORD='***' npm start"],
  ["PGPASSWORD=hunter2 psql", "PGPASSWORD=*** psql"],
  ["client_secret: hunter2", "client_secret: ***"],
  ["AWS_ACCESS_KEY_ID=fake AWS_SECRET_ACCESS_KEY=fake2 aws s3 ls", "AWS_ACCESS_KEY_ID=*** AWS_SECRET_ACCESS_KEY=*** aws s3 ls"],
  ["SSH_PRIVATE_KEY=fake deploy", "SSH_PRIVATE_KEY=*** deploy"],
  ["GOOGLE_CREDENTIALS=fake run", "GOOGLE_CREDENTIALS=*** run"],
  ["BASIC_AUTH=user:hunter2 curl x", "BASIC_AUTH=*** curl x"],
  ["apikey=hunter2", "apikey=***"],
  ["PASSWD=hunter2", "PASSWD=***"],
  ['{"token": "hunter2"}', '{"token": "***"}'],
  ['curl "https://api.example.com/v1?token=hunter2&page=2"', 'curl "https://api.example.com/v1?token=***&page=2"'],
  ["docker run --env=API_TOKEN=hunter2 img", "docker run --env=API_TOKEN=*** img"],
  ["curl -H 'x-api-key: hunter2' https://x", "curl -H 'x-api-key: ***' https://x"],
  // Authorization headers: a bare value, or <scheme> <credential> with the scheme kept
  ["AUTHORIZATION: raw-secret-abcdefgh", "AUTHORIZATION: ***"],
  [`curl -H "Authorization: token ghp_${z(36)}" https://x`, `curl -H "Authorization: token ***" https://x`],
  ['curl -H "Authorization: token fake" https://x', 'curl -H "Authorization: token ***" https://x'],
  ["Authorization: Basic dXNlcjpwYXNz && echo done", "Authorization: Basic *** && echo done"],
  ["Proxy-Authorization: Basic abc123def", "Proxy-Authorization: Basic ***"],
  ["X_AUTHORIZATION=fake2; ls", "X_AUTHORIZATION=***; ls"],
  ["Authorization: raw-secret-abcdefgh | tee log", "Authorization: *** | tee log"],
  ['{"Authorization": "Basic dXNlcjpwYXNz"}', '{"Authorization": "***"}'],
  // A name that is exactly KEY
  ["KEY=plainsecretvalue", "KEY=***"],
  ['key: "abc123secret"', 'key: "***"'],
  ["export KEY=abc", "export KEY=***"],
  // After a space, KEY=x is an env-style assignment even inside a flag's argument: masked, like any other KEY=x.
  ["docker build --build-arg KEY=abc123def .", "docker build --build-arg KEY=*** ."],
  // Secret flags (only exactly KEY is exempt in flag form)
  ["tool --password=hunter2x", "tool --password=***"],
  ["tool --api-key=abc123def", "tool --api-key=***"],
  ["tool --token=abc123def", "tool --token=***"],
  ["tool --secret=abc123def", "tool --secret=***"],
  ["mysql --password hunter2 -u root", "mysql --password *** -u root"],
  ["tool --token hunter2", "tool --token ***"],
  ['tool --secret "two words"', "tool --secret ***"],
  ["tool --api-key hunter2 --verbose", "tool --api-key *** --verbose"],
  ["tool --api-key=hunter2 --verbose", "tool --api-key=*** --verbose"],
  ["tool --password=hunter2", "tool --password=***"],
  // Unterminated quotes (text cut mid-value): masked to the end of the text, newlines included, keeping the opening quote
  ['echo ok && export AUDIT_SESSION_TOKEN="lgZfake', 'echo ok && export AUDIT_SESSION_TOKEN="***'],
  ["export API_KEY='fakevalue", "export API_KEY='***"],
  ['PASSWORD="fake2\nnext line of the script', 'PASSWORD="***'],
  ["SECRET='fake2\nmore", "SECRET='***"],
  ['{"action": "run", "token": "fakefake', '{"action": "run", "token": "***'],
  ['TOKEN="', 'TOKEN="***'],
  ["tool --password 'two words", "tool --password ***"],
  // OpenCadre keys glued onto preceding text (no word boundary)
  [`xxxxagt_${z(48)}`, "xxxxagt_***"],
  [`prefix_org_${z(48)} done`, "prefix_org_*** done"],
  [`log:dev_${z(48)}`, "log:dev_***"],
];

/** Normal commands and text that must come back unchanged. */
const NEGATIVE: string[] = [
  "rm -rf ./build",
  "git push --force origin main",
  "terraform destroy",
  "npm run dev",
  "docker run -p 8080:80 nginx",
  "cat src/token-bucket.ts",
  "vim src/token-bucket.ts:42",
  `git show ${"a1b2c3d4e5".repeat(4)}`,
  "git commit --author=\"A B <a@b.example>\" -m fix",
  "echo max_tokens=100 tokenizer: bert",
  "max_tokens=100",
  "git commit --author=me -m fix",
  "cat authorized_keys",
  "chmod 600 ~/.ssh/authorized_keys",
  "curl https://api.example.com/items",
  "echo monkey=1 turnkey: yes",
  // --key is a flag, not a secret name
  "sort --key=2 file",
  "aws s3 cp x s3://b --key=path/to/obj",
  "Bearer authentication is used here",
  String.raw`Claude Code wants to run this Bash command in C:\Users\dev\repo (rule: rm-rf).`,
  "pip install sk-learn-tutorials-2024",
  "open org_settings.ts and set the oc_session cookie",
  "curl http://localhost:8080/path",
  "ssh://git@github.com:22/o/r.git",
  "tool --token --verbose",
  "kubectl delete ns staging",
  // Identifiers that contain agt_/org_/dev_ but aren't keys
  "cat target_settings.json",
  "cargo_dev_build --release",
  "SELECT * FROM my_org_members",
  "rust_target_x86_64_linux",
  // Unterminated quotes that don't follow a secret name
  'git commit -m "fix TOKEN parsing',
  "echo it's fine",
  "",
];

describe("maskSecrets", () => {
  it.each(POSITIVE)("masks %s", (input, expected) => {
    expect(maskSecrets(input)).toBe(expected);
  });

  it.each(NEGATIVE.map((s) => [s]))("leaves %s unchanged", (input) => {
    expect(maskSecrets(input)).toBe(input);
  });

  it("is stable: masking masked text changes nothing", () => {
    for (const [, masked] of POSITIVE) expect(maskSecrets(masked)).toBe(masked);
  });

  it("never lets a fake secret through in any positive case", () => {
    for (const [input] of POSITIVE) {
      const out = maskSecrets(input);
      expect(out).not.toMatch(/0{10}|hunter2|fake|abc123|ZmFrZXNpZw|two words|raw-secret|dXNlcjpwYXNz|plainsecret|next line|more/);
    }
  });

  it("runs in linear time on adversarial input (agents choose the text)", () => {
    const n = 32_000;
    for (const input of ["sk-" + "a-".repeat(n / 2), "a-".repeat(n / 2), "a.".repeat(n / 2), "-a".repeat(n / 2), "Bearer " + "a".repeat(n), "a:".repeat(n / 2),
      'TOKEN="'.repeat(n / 7), "TOKEN='x\" ".repeat(n / 10), `agt_${"a".repeat(16)}-`.repeat(n / 21), `x${"agt_".repeat(n / 4)}`, "--password '".repeat(n / 12)]) {
      for (const mask of [maskSecrets, maskSecretsClient]) {
        // The fastest of three runs: a busy machine can pause any single run, but a quadratic pattern is slow every time.
        const runs = [0, 1, 2].map(() => {
          const started = performance.now();
          mask(input);
          return performance.now() - started;
        });
        expect(Math.min(...runs)).toBeLessThan(500);
      }
    }
  });

  it("an already-masked Authorization header is left as it is (no double mask)", () => {
    for (const text of ["Authorization: Bearer ***", "Authorization: Basic ***", "AUTHORIZATION: ***", 'curl -H "Authorization: token ***" https://x']) {
      expect(maskSecrets(text)).toBe(text);
      expect(maskSecretsClient(text)).toBe(text);
    }
  });

  it("the gate's client copy (scripts/opencadre-secrets.mjs) masks exactly the same way", () => {
    for (const [input] of POSITIVE) expect(maskSecretsClient(input)).toBe(maskSecrets(input));
    for (const input of NEGATIVE) expect(maskSecretsClient(input)).toBe(input);
  });
});

describe("maskDeep / maskEventRow", () => {
  it("masks every string in a payload, keeping keys and other values", () => {
    expect(maskDeep({ action: `A=agt_${z(48)}`, n: 3, list: ["ok", `ghp_${z(36)}`], nested: { note: null } }))
      .toEqual({ action: "A=agt_***", n: 3, list: ["ok", "ghp_***"], nested: { note: null } });
  });

  it("returns the same row when nothing needs masking, a masked copy otherwise", () => {
    const clean = { seq: 1, payload: JSON.stringify({ action: "rm -rf ./x" }) };
    expect(maskEventRow(clean)).toBe(clean);
    const leaky = { seq: 2, payload: JSON.stringify({ action: 'export API_KEY="abc123"' }) };
    const masked = maskEventRow(leaky);
    expect(JSON.parse(masked.payload)).toEqual({ action: 'export API_KEY="***"' });
    expect(leaky.payload).toContain("abc123");
  });
});
