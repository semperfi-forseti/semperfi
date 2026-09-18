import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);

const backendHost = '127.0.0.1';
const backendPort = 8000;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

function proxyToBackend(req, res) {
  const headers = { ...req.headers };

  // O backend deve receber o Host correspondente à API.
  headers.host = `${backendHost}:${backendPort}`;

  const proxyReq = httpRequest(
    {
      hostname: backendHost,
      port: backendPort,
      path: req.url,
      method: req.method,
      headers
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (error) => {
    console.error('Erro no proxy da API:', error.message);

    if (!res.headersSent) {
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }

    res.end(
      JSON.stringify({
        detail: 'Backend SEMPER-FI indisponível'
      })
    );
  });

  req.pipe(proxyReq);
}

createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || `127.0.0.1:${port}`}`
    );

    // Proxy da API:
    // http://127.0.0.1:4173/v1/*
    //              ↓
    // http://127.0.0.1:8000/v1/*
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
      proxyToBackend(req, res);
      return;
    }

    const requested =
      url.pathname === '/' ? '/index.html' : url.pathname;

    const filePath = normalize(
      join(root, decodeURIComponent(requested))
    );

    if (!filePath.startsWith(normalize(root))) {
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8'
      });
      res.end('Forbidden');
      return;
    }

    const body = await readFile(filePath);

    res.writeHead(200, {
      'Content-Type':
        mimeTypes[extname(filePath)] || 'application/octet-stream'
    });

    res.end(body);
  } catch {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8'
    });

    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`SEMPER-FI frontend: http://127.0.0.1:${port}`);
  console.log(
    `SEMPER-FI API proxy: http://127.0.0.1:${port}/v1 -> http://${backendHost}:${backendPort}/v1`
  );
});