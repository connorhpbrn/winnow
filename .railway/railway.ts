import { defineRailway, github, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const shared = {
    NODE_ENV: "production",
    DATABASE_URL: preserve(),
    DATABASE_DIRECT_URL: preserve(),
    OPENROUTER_API_KEY: preserve(),
    OPENROUTER_HTTP_REFERER: preserve(),
    OPENROUTER_APP_TITLE: "Winnow",
    TELEGRAM_BOT_TOKEN: preserve(),
  };

  const bot = service("winnow-bot", {
    source: github("connorhpbrn/winnow", { branch: "main" }),
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    env: {
      ...shared,
      PUBLIC_BASE_URL: preserve(),
    },
  });

  return project("winnow", {
    resources: [bot],
  });
});
