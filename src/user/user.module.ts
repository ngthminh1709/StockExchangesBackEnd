import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthEntity } from '../auth/entities/auth.entity';
import { UserEntity } from './entities/user.entity';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import {JwtService} from "@nestjs/jwt";

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, AuthEntity])],
  controllers: [UserController],
  providers: [UserService, JwtService],
})
export class UserModule {}
