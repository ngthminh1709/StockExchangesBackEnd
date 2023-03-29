import { HttpStatus, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { Repository } from "typeorm";
import { ExceptionResponse } from "../exceptions/common.exception";
import { UserResponse } from "../user/responses/UserResponse";
import { UserEntity } from "../user/entities/user.entity";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { Response } from "express";
import { TimeToLive } from "../enums/common.enum";
import { DeviceEntity } from "./entities/device.entity";
import { MRequest } from "../types/middleware";
import { randomUUID } from "crypto";
import { UtilCommonTemplate } from "../utils/utils.common";
import { RefreshTokenResponse } from "./responses/RefreshToken.response";
import { DeviceLoginInterface } from "./interfaces/device-login.interface";
import { DeviceSessionResponse } from "./responses/DeviceSession.response";

@Injectable()
export class AuthService {

  constructor(
    @InjectRepository(DeviceEntity)
    private readonly deviceRepo: Repository<DeviceEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly jwtService: JwtService
  ) {
  }

  generateAccessToken(userId: number, role: number, deviceId: string, secretKey: string): string {
    return this.jwtService.sign({
      userId: userId,
      role: role,
      deviceId: deviceId
    }, {
      secret: secretKey,
      expiresIn: TimeToLive.OneDayMiliSeconds
    });
  }

  generateRefreshToken(userId: number, deviceId: string): string {
    return this.jwtService.sign({
      userId: userId,
      deviceId: deviceId
    }, {
      secret: process.env.REFRESH_TOKEN_SECRET,
      expiresIn: TimeToLive.OneWeekMiliSeconds
    });
  }

  async register(data: RegisterDto): Promise<boolean> {
    const user = await this.userRepo.findOne({
      where: { account_name: data.account_name }
    });
    if (user) {
      throw new ExceptionResponse(HttpStatus.BAD_REQUEST, "Tài khoản đã được đăng ký");
    }
    const saltOrRounds = 10;
    const hash: string = await bcrypt.hash(data.password, saltOrRounds);
    const userSave: UserEntity = await this.userRepo.save({
      ...data,
      password: hash
    });
    await this.deviceRepo.save({ user: userSave });

    return true;
  }

  async login(req: MRequest, loginDto: LoginDto, headers: Headers, res: Response): Promise<UserResponse> {
    const { account_name, password } = loginDto;
    const user = await this.userRepo.findOne({ where: { account_name } });
    if (!user) {
      throw new ExceptionResponse(HttpStatus.BAD_REQUEST, "Tài khoản không tồn tại");
    }

    const isPasswordMatch = await bcrypt.compare(password, user.password);
    if (!isPasswordMatch) {
      throw new ExceptionResponse(HttpStatus.BAD_REQUEST, "Tài khoản / mật khẩu không chính xác");
    }

    // Lấy thông tin MAC ID, Device ID, địa chỉ IP và User Agent
    const macId: string = req.mac;
    const deviceId: string = req.deviceId;
    const ipAddress: string = req.socket.remoteAddress;
    const userAgent: string = headers["user-agent"];

    // Xử lý phiên đăng nhập của thiết bị
    const {
      accessToken,
      refreshToken,
      expiredAt
    } = await this.handleDeviceSession(user, macId, deviceId, ipAddress, userAgent);

    // Lưu cookie refreshToken
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      path: "/"
    });

    // Trả về thông tin người dùng kèm access token và thời gian hết hạn
    return new UserResponse({
      ...user,
      access_token: accessToken,
      expired_at: expiredAt
    });
  }

  async handleDeviceSession(user: UserEntity, macId: string, deviceId: string, ipAddress: string, userAgent: string): Promise<DeviceLoginInterface> {
    // Tìm kiếm thiết bị hiện tại theo device_id
    const currentDevice = await this.deviceRepo.findOne({ where: { device_id: deviceId } });

    // Tạo secretKey ngẫu nhiên bằng uuid
    const secretKey: string = UtilCommonTemplate.uuid();

    // Tạo accessToken, refreshToken và expiredAt mới
    const accessToken: string = this.generateAccessToken(user.user_id, user.role, deviceId, secretKey);
    const refreshToken: string = this.generateRefreshToken(user.user_id, deviceId);
    const expiredAt: Date = new Date(Date.now() + TimeToLive.OneDayMiliSeconds);

    // Lưu thông tin của thiết bị mới vào database
    const newDevice = await this.deviceRepo.save({
      id: currentDevice?.id || randomUUID(),
      user: user,
      mac_id: macId,
      device_id: deviceId,
      user_agent: userAgent,
      expired_at: expiredAt,
      ip_address: ipAddress,
      secret_key: secretKey,
      refresh_token: refreshToken
    });

    // Thêm thiết bị mới vào danh sách các thiết bị của user
    user.devices?.push(newDevice);
    await this.userRepo.save(user);

    // Trả về accessToken, refreshToken và expiredAt mới
    return { accessToken, refreshToken, expiredAt };
  }

  async logout(userId: number, deviceId: string, res: Response): Promise<boolean> {
    const currentSession = await this.deviceRepo
      .createQueryBuilder("device")
      .leftJoinAndSelect("device.user", "user")
      .select(["device", "user.user_id"])
      .where("device.device_id = :deviceId", { deviceId })
      .andWhere("user.user_id = :userId", { userId })
      .getOne();

    if (!currentSession || currentSession.user.user_id !== userId) {
      throw new ExceptionResponse(HttpStatus.FORBIDDEN, "you are not allow to do that");
    }

    res.cookie("refreshToken", "", {
      maxAge: -1,
      path: "/",
      httpOnly: true
    });

    await this.deviceRepo.delete({ device_id: deviceId });
    return true;
  }

  async refreshToken(req: MRequest, res: Response): Promise<RefreshTokenResponse> {
    // Lấy refresh token từ cookies của request
    const refreshToken: string = req.cookies["refreshToken"];
    if (!refreshToken) {
      // Nếu không tìm thấy refresh token trong cookies thì trả về lỗi BAD_REQUEST
      throw new ExceptionResponse(HttpStatus.BAD_REQUEST, "refresh token not found");
    }
    // Lấy deviceId từ request
    const deviceId: string = req.deviceId;

    // Tìm kiếm device hiện tại trong database theo refreshToken và deviceId
    const currentDevice: DeviceEntity = await this.deviceRepo
      .createQueryBuilder("device")
      .select("device", "user.user_id")
      .leftJoinAndSelect("device.user", "user")
      .where("device.refresh_token = :refreshToken", { refreshToken })
      .andWhere("device.device_id = :deviceId", { deviceId })
      .getOne();

    if (!currentDevice) {
      // Nếu không tìm thấy device trong database thì trả về lỗi BAD_REQUEST
      throw new ExceptionResponse(HttpStatus.BAD_REQUEST, "refresh token is not valid");
    }

    // Lấy thời gian hết hạn của refreshToken
    const refreshExpired: number = (this.jwtService.decode(refreshToken))?.["exp"] * 1000;
    if (refreshExpired < new Date().valueOf()) {
      // Nếu refreshToken đã hết hạn thì trả về lỗi BAD_REQUEST
      throw new ExceptionResponse(HttpStatus.BAD_REQUEST, "refresh token is not valid");
    }

    if (!this.jwtService.verify(refreshToken, { secret: process.env.REFRESH_TOKEN_SECRET })) {
      // Nếu refreshToken không hợp lệ thì trả về lỗi BAD_REQUEST
      throw new ExceptionResponse(HttpStatus.BAD_REQUEST, "refresh token is not valid");
    }

    // Tạo secretKey mới để sử dụng cho accessToken
    const secretKey = UtilCommonTemplate.uuid();
    // Tạo accessToken mới
    const newAccessToken: string = this.generateAccessToken(currentDevice.user.user_id, currentDevice.user.role, deviceId, secretKey);
    // Tạo refreshToken mới
    const newRefreshToken: string = this.generateRefreshToken(currentDevice.user.user_id, deviceId);

    // Lưu refreshToken mới vào cookies của response
    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      path: "/"
    });
    // Cập nhật thông tin của device trong database
    const expiredAt: Date = new Date(Date.now() + TimeToLive.OneDayMiliSeconds);
    await this.deviceRepo.update({ device_id: deviceId },
      {
        secret_key: secretKey,
        refresh_token: newRefreshToken,
        expired_at: expiredAt
      });
    // Trả về đối tượng RefreshTokenResponse cho client
    return new RefreshTokenResponse({
      access_token: newAccessToken,
      expire_at: expiredAt
    });
  }

  async getSecretKey(deviceId: string): Promise<string> {
    return (await this.deviceRepo.findOne({
        where: { device_id: deviceId },
        select: ["secret_key"]
      })
    )?.["secret_key"];
  }

  async getHistorySession(userId: number) {
    const data: DeviceEntity[] = await this.deviceRepo
      .createQueryBuilder("device")
      .innerJoinAndSelect("device.user", "user")
      .where("user.user_id = :userId", { userId })
      .getMany();

    return new DeviceSessionResponse().mapToList(data);
  }
}