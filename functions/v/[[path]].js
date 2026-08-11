/* /v/<credential-id> — the short form the certificate QR code points at.
 *
 * Identical to /verify/<id>. It exists because the QR encodes a URL, and five
 * fewer characters keeps the symbol at a lower version — fewer, larger modules
 * at the same 22mm, which is the difference between a discreet QR that scans
 * and one that merely looks tidy.
 *
 * Same reasoning as functions/verify/[[path]].js for why this is a Function
 * and not a _redirects rewrite: the 200-rewrite form is silently ignored.
 */

export { onRequest } from "../verify/[[path]].js";
