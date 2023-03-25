import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { HttpStatus, ValidationError, ValidationPipe } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import { join } from "path";
import { ExceptionResponse } from "./exceptions/common.exception";
import { UtilCommonTemplate } from "./utils/utils.common";
import { ValidationFilter } from "./filters/validation.filter";
import * as cookieParser from 'cookie-parser';
import { HttpLogger } from "./interceptors/http-logger";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: true,
  });
  // app.enableCors({
  //   origin: [], // add your IP whitelist here
  //   methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  //   preflightContinue: false,
  //   optionsSuccessStatus: 204,
  //   credentials: true,
  //   allowedHeaders: 'Origin,X-Requested-With,Content-Type,Accept,Authorization',
  // });

  app.enableCors({origin: '*'})

  app.use(cookieParser());
  app.setGlobalPrefix(process.env.API_PREFIX);
  app.useGlobalInterceptors(new HttpLogger());

  const config = new DocumentBuilder()
    .addBearerAuth()
    .setTitle('Stock Swagger')
    .setDescription('Stock API - Talented Investor')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'Stock Swagger',
  });

  app.useGlobalFilters(new ValidationFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      exceptionFactory(errors: ValidationError[]) {
        return new ExceptionResponse(
          HttpStatus.BAD_REQUEST,
          UtilCommonTemplate.getMessageValidator(errors),
        );
      },
    }),
  );

  app.useStaticAssets(join(__dirname, '..', 'public'));

  await app.listen(parseInt(process.env.SERVER_PORT)).then(() => {
    console.log(
      `Server is running at ${process.env.SERVER_HOST}:${process.env.SERVER_PORT} --version: 0.0.02`,
    );
  });
}

bootstrap();
