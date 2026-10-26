import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp(config);

try {
  await app.listen({ host: config.host, port: config.port });
  if (!config.isProduction && config.apiToken === "local-dev-token") {
    app.log.warn("Using development token 'local-dev-token'; set PS5_CAFE_API_TOKEN before sharing the LAN service");
  }
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Shutting down");
    // Backstop: a connection or device call that refuses to finish must not keep the process alive forever.
    setTimeout(() => { app.log.error("Graceful shutdown did not finish within 10 s; exiting"); process.exit(1); }, 10_000).unref();
    app.close().then(() => process.exit(0), (error: unknown) => { app.log.error(error); process.exit(1); });
  });
}
