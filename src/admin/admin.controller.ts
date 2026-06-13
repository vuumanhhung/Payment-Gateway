import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as path from 'path';
import { GateType } from 'src/gateways/gate.interface';
import { AdminAuthService } from './admin-auth.service';
import { AdminSessionGuard } from './admin-session.guard';
import { AdminService } from './admin.service';

@Controller()
export class AdminPageController {
  constructor(private readonly authService: AdminAuthService) {}

  @Get(':secretPath')
  showAdmin(
    @Param('secretPath') secretPath: string,
    @Res() response: Response,
  ) {
    if (!this.authService.isSecretPath(secretPath)) {
      throw new NotFoundException();
    }
    return response.sendFile(
      path.join(process.cwd(), 'admin-ui', 'admin.html'),
    );
  }
}

@Controller('api/admin/:secretPath')
export class AdminController {
  constructor(
    private readonly authService: AdminAuthService,
    private readonly adminService: AdminService,
  ) {}

  @Post('login')
  async login(
    @Param('secretPath') secretPath: string,
    @Body() body: { password: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.authService.assertSecretPath(secretPath);
    const token = await this.authService.login(
      body.password,
      request.ip || request.socket.remoteAddress || 'unknown',
    );
    response.setHeader(
      'Set-Cookie',
      this.authService.getSessionCookie(token, request.secure),
    );
    return { authenticated: true };
  }

  @Get('session')
  getSession(@Param('secretPath') secretPath: string, @Req() request: Request) {
    this.authService.assertSecretPath(secretPath);
    return {
      authenticated: this.authService.isAuthenticated(request, secretPath),
    };
  }

  @Post('logout')
  @UseGuards(AdminSessionGuard)
  logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader(
      'Set-Cookie',
      this.authService.getExpiredSessionCookie(request.secure),
    );
    return { authenticated: false };
  }

  @Get('overview')
  @UseGuards(AdminSessionGuard)
  getOverview() {
    return this.adminService.getOverview();
  }

  @Get('banks')
  @UseGuards(AdminSessionGuard)
  getBanks() {
    return this.adminService.getBanks();
  }

  @Post('banks')
  @UseGuards(AdminSessionGuard)
  createBank(
    @Body()
    body: {
      name: string;
      type: GateType;
      enabled?: boolean;
      loginId?: string;
      password?: string;
      account: string;
      accountName?: string;
      bankId?: string;
      deviceId?: string;
      userAgent?: string;
    },
  ) {
    return this.adminService.createBank(body);
  }

  @Patch('banks/:name/toggle')
  @UseGuards(AdminSessionGuard)
  toggleBank(@Param('name') name: string, @Body() body: { enabled: boolean }) {
    return this.adminService.toggleBank(name, body.enabled === true);
  }

  @Patch('banks/:name')
  @UseGuards(AdminSessionGuard)
  updateBank(
    @Param('name') name: string,
    @Body()
    body: {
      type?: GateType;
      enabled?: boolean;
      loginId?: string;
      password?: string;
      account?: string;
      accountName?: string;
      bankId?: string;
      deviceId?: string;
      userAgent?: string;
    },
  ) {
    return this.adminService.updateBank(name, body);
  }

  @Get('transactions')
  @UseGuards(AdminSessionGuard)
  getTransactions(
    @Query('query') query?: string,
    @Query('gate') gate?: string,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getTransactions(query, gate, limit);
  }
}
