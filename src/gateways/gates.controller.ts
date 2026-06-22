import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { GatesManagerService } from './gates-manager.services';
import * as moment from 'moment-timezone';
import { OnEvent } from '@nestjs/event-emitter';
import { GATEWAY_START_CRON, GATEWAY_STOP_CRON } from 'src/shards/events';
import { ConfigService } from '@nestjs/config';

@Controller('gateways')
export class GatesController {
  private readonly lastManualScanAt = new Map<string, number>();
  private readonly manualScanCooldownMs = 15_000;

  constructor(
    private readonly gateManagerService: GatesManagerService,
    private readonly configService: ConfigService,
  ) {}

  @Post('scan')
  @HttpCode(HttpStatus.OK)
  async scanOnce(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { name?: string },
  ) {
    const expectedToken = this.configService.get<string>('GATEWAY_API_TOKEN');
    if (
      !expectedToken ||
      authorization !== `Bearer ${expectedToken}`
    ) {
      throw new UnauthorizedException('API token không hợp lệ');
    }

    const name = body?.name?.trim();
    if (!name) {
      throw new HttpException(
        'Thiếu tên gateway',
        HttpStatus.BAD_REQUEST,
      );
    }

    const now = Date.now();
    const lastScanAt = this.lastManualScanAt.get(name) ?? 0;
    const retryAfterMs = this.manualScanCooldownMs - (now - lastScanAt);
    if (retryAfterMs > 0) {
      throw new HttpException(
        {
          message: 'Gateway vừa được kiểm tra, vui lòng chờ một chút',
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.lastManualScanAt.set(name, now);
    try {
      const payments = await this.gateManagerService.scanGateOnce(name);
      return { payments };
    } catch (error) {
      this.lastManualScanAt.delete(name);
      throw error;
    }
  }

  @Get('stop-gate')
  stopGate(
    @Query('name') name: string,
    @Query('time_in_sec') timeInSec: number,
  ) {
    this.gateManagerService.stopCron(name, timeInSec);
    return {
      message: 'ok',
      next_run: moment()
        .add(timeInSec, 'seconds')
        .tz('Asia/Ho_Chi_Minh')
        .format('DD-MM-YYYY HH:mm:ss'),
    };
  }

  @OnEvent(GATEWAY_STOP_CRON)
  stopGateCron(payload?: { minutes: number }) {
    const minutes = payload?.minutes || 5;
    this.gateManagerService.stopAllCron(minutes);
  }

  @OnEvent(GATEWAY_START_CRON)
  startGateCron() {
    this.gateManagerService.startAllCron();
  }
}
