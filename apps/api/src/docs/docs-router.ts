import express, { Router } from "express";
import helmet from "helmet";
import swaggerUiDist from "swagger-ui-dist";
import { buildOpenApi } from "./openapi.js";

/**
 * The interactive API reference (Swagger UI), self-hosted: no third-party scripts, so the page
 * works under a strict Content-Security-Policy and offline. Mounted at /api/docs only when
 * DOCS_ENABLED (default: development). It carries no data, only the shape of the API.
 */
export function docsRouter(): Router {
  const router = Router();
  const spec = buildOpenApi();

  router.use(
    helmet({
      // Its own policy: only this page's files, no inline script, no upgrade-insecure-requests
      // (which would break http://localhost).
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    }),
  );

  router.get("/openapi.json", (_req, res) => {
    res.json(spec);
  });
  router.get("/init.js", (_req, res) => {
    res
      .type("application/javascript")
      .send(
        [
          "window.onload = function () {",
          "  window.ui = SwaggerUIBundle({",
          '    url: "/api/docs/openapi.json",',
          '    dom_id: "#swagger-ui",',
          "    deepLinking: true,",
          "    docExpansion: 'none',",
          '    layout: "BaseLayout",',
          "    presets: [SwaggerUIBundle.presets.apis],",
          "  });",
          "};",
        ].join("\n"),
      );
  });
  router.get(["/", "/index.html"], (_req, res) => {
    res.type("html").send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MediQ API reference</title><link rel="stylesheet" href="/api/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="/api/docs/swagger-ui-bundle.js"></script><script src="/api/docs/init.js"></script></body></html>`,
    );
  });
  // Swagger UI's own files (script, stylesheet, fonts).
  router.use(express.static(swaggerUiDist.getAbsoluteFSPath(), { index: false }));
  return router;
}
