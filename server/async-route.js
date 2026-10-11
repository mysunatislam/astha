// Express 4 does not forward rejected handler promises to its error middleware.
// Return the promise as well so isolated route tests can await completion.
export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
}
