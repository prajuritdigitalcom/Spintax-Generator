import path from "path";
import { createServer as createViteServer } from "vite";
import app from "./api/index";

const PORT = 3000;

// Serve frontend static assets & fallback to SPA routing
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    // Development mode
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production mode
    const distPath = path.join(process.cwd(), "dist");
    app.use(expressStaticMiddleware(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AI Contextual Spintax Generator running on http://0.0.0.0:${PORT}`);
  });
}

// A wrapper helper to satisfy TypeScript's dynamic express static serving
function expressStaticMiddleware(distPath: string) {
  const express = require("express");
  return express.static(distPath);
}

startServer();
