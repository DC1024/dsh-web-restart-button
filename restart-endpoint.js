// Minimal control endpoint: any request restarts dsh.
//
// Why this exists: the community "restart button" plugins assume a desktop
// launcher or systemd and register no routes under the web profile, so they
// are dead weight in a container. Here the whole mechanism is explicit:
//
//   browser -> nginx (HTTP Basic Auth) -> this listener -> kill dsh
//           -> entrypoint notices dsh is gone -> container exits
//           -> Docker `restart: unless-stopped` brings the stack back
//
// It binds to 127.0.0.1 only. There is no way to reach it except through
// nginx, which means Basic Auth always applies.
const { createServer } = require('node:http');
const { exec } = require('node:child_process');

const PORT = Number(process.env.RESTART_PORT || 8099);

createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Connection': 'close',
    'Cache-Control': 'no-store',
  });
  res.end('Restarting dsh.\nThe page will come back by itself in about 30-60 seconds.\n');

  // Flush the response before pulling the process out from under us.
  setTimeout(() => {
    exec('pkill -f "dsh web"', () => {});
  }, 250);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`restart endpoint listening on 127.0.0.1:${PORT}`);
});
