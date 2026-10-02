import type { Core } from "@strapi/strapi";

const config: Core.Config.Middlewares = [
  "strapi::logger",
  "strapi::errors",
  "strapi::security",
  "global::engraving-files",

  {
    name: "strapi::cors",
    config: {
      origin: [
        // production
        "https://new.cocktaildesign.ru",
        "https://cocktaildesign.ru",
        "https://www.cocktaildesign.ru",

        // development
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://192.168.1.126:3000",
        "http://192.168.1.162:3000",
        "http://192.168.0.4:3000",
      ],
      credentials: true,
      headers: "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    },
  },

  "strapi::poweredBy",
  "strapi::query",

  {
    name: "strapi::body",
    config: {
      formLimit: "50mb",
      jsonLimit: "50mb",
      textLimit: "50mb",
      formidable: {
        maxFileSize: 50 * 1024 * 1024,
      },
    },
  },

  "strapi::session",
  "strapi::favicon",
  "strapi::public",
];

export default config;
