// Interactive API docs — Swagger UI at /api/docs over the hand-maintained
// OpenAPI spec (server/openapi.js). Sits behind the normal auth gate: docs
// are for signed-in users. The UI assets load from the unpkg CDN so we ship
// no extra dependency; the spec itself is served locally.
const { buildSpec } = require('../openapi');

const SWAGGER_VERSION = '5.17.14';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>SentinelKYC API docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css" />
  <style>body { margin: 0 } .topbar { display: none }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/api/docs/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      tryItOutEnabled: true,
      requestInterceptor: (req) => req, // session cookie rides along same-origin
    });
  </script>
</body>
</html>`;

function register(app) {
  let specCache = null;

  app.get('/api/docs/openapi.json', (_req, res) => {
    if (!specCache) specCache = buildSpec();
    res.json(specCache);
  });

  app.get('/api/docs', (_req, res) => {
    res.type('html').send(PAGE);
  });
}

module.exports = { register };
