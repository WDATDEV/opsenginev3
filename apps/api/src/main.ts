import "./load-env.js";
import "reflect-metadata";
import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { ForbiddenErrorFilter, TrackingErrorFilter } from "./http.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.useGlobalFilters(new ForbiddenErrorFilter(), new TrackingErrorFilter());
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3010",
    credentials: true,
  });
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3011);
  await app.listen(port, "0.0.0.0");
  console.log(`API listening on ${port}`);
}

bootstrap();
