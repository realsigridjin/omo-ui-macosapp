import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./dsh/theme/brand-font.css";
import "./dsh/theme/geist-font.css";
import "./dsh/theme/base.css";
import "./dsh/theme/corner-shape.css";
import "./dsh/theme/design-platform.css";
import "./dsh/theme/focus.css";
import "./dsh/theme/onboarding.css";
import "./dsh/theme/scrollbar.css";
import "./dsh/theme/gradient-shadow-text.css";
import "./dsh/theme/shiki.css";
import "./ui/theme/omo-theme.css";
import "./ui/theme/color-themes.css";
import "./ui/app.css";
import { App } from "./App";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
