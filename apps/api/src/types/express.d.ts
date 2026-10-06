import type { AuthContext } from "../middleware/authenticate.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware. */
      auth?: AuthContext;
    }
  }
}

export {};
