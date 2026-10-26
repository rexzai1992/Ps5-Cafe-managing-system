import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { parsePublicRoute } from "./navigation.js";
import { BookingPage } from "./pages/BookingPage.js";
import { ScreenPage } from "./pages/ScreenPage.js";
import "./styles.css";

/** TV screens and customer booking pages never mount the staff dashboard, so they never use the staff token. */
function Root() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const route = parsePublicRoute(hash);
  if (route?.kind === "screen") return <ScreenPage key={route.stationId} stationId={route.stationId} screenKey={route.key} preview={route.preview} />;
  if (route?.kind === "book") return <BookingPage key={`${route.stationId}-${route.code}`} stationId={route.stationId} code={route.code} />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
