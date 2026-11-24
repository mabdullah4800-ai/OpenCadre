/** The raw bytes of a request body, kept past `express.json()` so an inbound webhook can be verified against exactly
 * what was signed.
 *
 * Moved here unchanged from src/stripe-signature.ts when billing moved to the payment provider: the capture is provider-neutral,
 * and the payment provider's own guide says the same thing Stripe's did -- "Don't transform or process the raw body of the
 * request ... This results in a different signed payload"
 * (https://developer.paddle.com/webhooks/about/signature-verification).
 *
 * The `verify` hook is preferred to mounting `express.raw()` on one route because it is order-independent: a route
 * registered after the parser still gets the bytes, so a later refactor cannot silence verification by moving a line. */

export interface RawBodyCarrier {
  /** Written by `captureRawBody`, which is the `verify` hook express.json() is configured with. */
  rawBody?: Buffer;
  /** What express sets when a body parser consumed the stream without capturing it. */
  body?: unknown;
}

/** The `verify` hook to hand to a body parser: `app.use(express.json({ verify: captureRawBody }))`. express calls
 * it with the buffer BEFORE it parses, so this is the only place the signed bytes exist. It lives on the request
 * rather than in a module-level cache, so two concurrent webhooks can never see each other's body.
 *
 * `req` is typed `object` because express passes an IncomingMessage, which shares no properties with the all-optional
 * RawBodyCarrier (TypeScript's weak-type check would refuse the call). */
export function captureRawBody(req: object, _res: unknown, buf: Buffer): void {
  (req as RawBodyCarrier).rawBody = buf;
}

/** The bytes to verify, or null when there are none. MUST be null-checked by the caller: a parser that ran without
 * the hook leaves only a parsed object, and verifying `JSON.stringify(req.body)` would verify a re-serialization the
 * provider never signed. A `Buffer` check, so a string parked on `rawBody` by something else is not mistaken for it. */
export function signedBodyOf(req: RawBodyCarrier): Buffer | null {
  return Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
}
